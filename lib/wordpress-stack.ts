import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Networking } from './networking';

interface WordpressStackProps extends cdk.StackProps {
  DEBUG_MODE: boolean;
  WORDPRESS_IMAGE: string;
}

export class WordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: WordpressStackProps) {
    super(scope, id, props);

    const network = new Networking(this, 'networking', { maxAzs: 2 });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'sg-db', {
      vpc: network.vpc,
      allowAllOutbound: true,
    });

    const database = new rds.DatabaseInstance(this, 'db-mysql', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7, // lets use 5.7,  same as in docker compose test
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
      databaseName: 'wordpress',
      vpc: network.vpc,
      allocatedStorage: 20, // Minimum storage
      maxAllocatedStorage: 100, // Allow for auto-scaling
      multiAz: false, // Single-AZ for cost savings
      publiclyAccessible: false, // For security
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      backupRetention: cdk.Duration.days(7), // Adjust as needed
      deletionProtection: false, // Disable for development
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Adjust as needed
      securityGroups: [dbSecurityGroup],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'ecs-cluster', {
      vpc: network.vpc,
      containerInsights: true,
    });

    const loadBalancedFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        'fargate-service',
        {
          cluster,
          memoryLimitMiB: 512, // 0.5 GB
          cpu: 256, // 0.5 vCPU
          taskImageOptions: {
            image: ecs.ContainerImage.fromRegistry(
              props?.WORDPRESS_IMAGE ?? 'wordpress:6',
            ),
            environment: {
              WORDPRESS_DB_NAME: 'wordpress',
              WORDPRESS_DEBUG: props?.DEBUG_MODE ? '1' : '0',
            },
            secrets: {
              WORDPRESS_DB_HOST: ecs.Secret.fromSecretsManager(
                database.secret!,
                'host',
              ),
              WORDPRESS_DB_USER: ecs.Secret.fromSecretsManager(
                database.secret!,
                'username',
              ),
              WORDPRESS_DB_PASSWORD: ecs.Secret.fromSecretsManager(
                database.secret!,
                'password',
              ),
            },
          },
          circuitBreaker: { enable: true, rollback: true }, // Enable circuit breaker to rollback on failure
          desiredCount: 1,
          assignPublicIp: true,
          taskSubnets: {
            subnetType: ec2.SubnetType.PUBLIC, // if we put this into a private subnet it can not fetch aws secrets and container images
          },
          publicLoadBalancer: true,
        },
      );

    loadBalancedFargateService.targetGroup.healthCheck = {
      path: '/wp-includes/images/blank.gif',
      interval: cdk.Duration.minutes(1),
    };

    dbSecurityGroup.addIngressRule(
      loadBalancedFargateService.service.connections.securityGroups[0],
      ec2.Port.tcp(3306),
      'Allow MySQL traffic from Fargate service',
    );

    // loadBalancedFargateService.node.addDependency(database); // Ensure database is created first
  }
}
