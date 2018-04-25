'use strict';

const semver = require('semver');
const set = require('lodash.set');

const ROLE_RESOURCE = 'TimberRole';
const FUNCTION_RESOURCE = 'CloudwatchToTimber';
const PERMISSION_RESOURCE = 'CloudwatchToTimberPermission';

function roleTemplate(serviceName, stage, region) {
  return {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: `${serviceName}-${stage}-${region}-cloudWatchToTimberRole`,
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: [
                'lambda.amazonaws.com'
              ]
            },
            Action: [
              'sts:AssumeRole'
            ]
          }
        ]
      },
      Path: '/',
      Policies: [
        {
          PolicyName: 'cloudwatch',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'logs:CreateLogGroup',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents'
                ],
                Resource: [
                  'arn:aws:logs:*:*:*'
                ]
              }
            ]
          }
        }
      ]
    }
  };
}


function functionTemplate(serviceName, stage, apiKey) {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Code: {
        S3Bucket: 'takeshape-api.dev.assets',
        S3Key: 'timber-cloudwatch-logs-lambda-function-latest.zip'
      },
      FunctionName: `${serviceName}-${stage}-cloudwatchLogsToTimber`,
      Handler: 'main.lambda_handler',
      MemorySize: 128,
      Role: {
        'Fn::GetAtt': [
          ROLE_RESOURCE,
          'Arn'
        ]
      },
      Runtime: 'python3.6',
      Timeout: 6,
      Environment: {
        Variables: {
          TIMBER_API_KEY: apiKey
        }
      }
    },
    DependsOn: [
      ROLE_RESOURCE
    ]
  };
}


function subscriptionFilterTemplate(logGroupName, logGroupLogicalId) {
  return {
    Type: 'AWS::Logs::SubscriptionFilter',
    Properties: {
      DestinationArn: {
        'Fn::GetAtt': [
          FUNCTION_RESOURCE,
          'Arn'
        ]
      },
      FilterPattern: '',
      LogGroupName: logGroupName,
    },
    DependsOn: [
      FUNCTION_RESOURCE,
      PERMISSION_RESOURCE,
      logGroupLogicalId
    ]
  };
}


function permissionTemplate(functionPrefix) {
  return {
    Type: 'AWS::Lambda::Permission',
    Properties: {
      FunctionName: {
        'Fn::GetAtt': [
          FUNCTION_RESOURCE,
          'Arn'
        ]
      },
      Action: 'lambda:InvokeFunction',
      Principal: {
        'Fn::Join': [
          '.',
          [
            'logs',
            {
              Ref: 'AWS::Region'
            },
            'amazonaws',
            'com'
          ]
        ]
      },
      SourceArn: {
        'Fn::Join': [
          '',
          [
            'arn:aws:logs:',
            {
              Ref: 'AWS::Region'
            },
            ':',
            {
              Ref: 'AWS::AccountId'
            },
            `:log-group:/aws/lambda/${functionPrefix}*`
          ]
        ]
      }
    }
  };
}

class CloudWatchToTimber {
  constructor(serverless, options) {
    if (!semver.satisfies(serverless.version, '>= 1.12')) {
      throw new Error('serverless-plugin-timber requires serverless 1.12 or higher!');
    }

    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');
    this.hooks = {
      'package:createDeploymentArtifacts': () => this.addTimber(),
    };
  }

  addTimber() {
    const service = this.serverless.service;
    if (typeof service.functions !== 'object') {
      this.serverless.cli.log('Timber: No functions to log');
      return;
    }

    const config = (service.custom && service.custom.timber) || {};

    if (!config.apiKey) {
      this.serverless.cli.log('Timber: missing apiKey');
      return;
    }

    const serviceName = this.provider.serverless.service.service;
    const stage = this.provider.getStage();
    const region = this.provider.getRegion();
    const functionPrefix = `${serviceName}-${stage}-`;

    set(service, `resources.Resources[${ROLE_RESOURCE}]`, roleTemplate(serviceName, stage, region));
    set(service, `resources.Resources[${FUNCTION_RESOURCE}]`, functionTemplate(serviceName, stage, config.apiKey));
    set(service, `resources.Resources[${PERMISSION_RESOURCE}]`, permissionTemplate(functionPrefix));

    Object.keys(service.functions).forEach(functionName => {
      if (service.functions[functionName].timber !== false) {
        const logGroupName = this.provider.naming.getLogGroupName(`${functionPrefix}${functionName}`);
        const logGroupLogicalId = this.provider.naming.getLogGroupLogicalId(functionName);
        const subscriptionFilter = subscriptionFilterTemplate(logGroupName, logGroupLogicalId);
        set(service, `resources.Resources[${logGroupLogicalId}ToTimber]`, subscriptionFilter);
      }
    });
  }
}

module.exports = CloudWatchToTimber;
