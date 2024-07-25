import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Networking } from './networking';

export class WordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    // example resource
    const queue = new sqs.Queue(this, 'CdkExampleProjectQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
    });

    const network = new Networking(this, 'MyNetworking', { maxAzs: 2 });

    const database = new rds.DatabaseInstance(this, 'MyDatabase', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_37,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE3,
        ec2.InstanceSize.MICRO,
      ),
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
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'MyCluster', {
      vpc: network.vpc,
    });

    const autoScalingGroup = cluster.addCapacity('ASG', {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3A,
        ec2.InstanceSize.SMALL,
      ),
      maxCapacity: 3,
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
    });
    autoScalingGroup.scaleOnCpuUtilization('KeepCpuHalfwayLoaded', {
      targetUtilizationPercent: 50,
    });

    const loadBalancedFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        'MyFargateService',
        {
          cluster,
          memoryLimitMiB: 512, // 0.5 GB
          cpu: 256, // 0.5 vCPU
          taskImageOptions: {
            image: ecs.ContainerImage.fromRegistry('wordpress:6-fpm'),
            environment: {
              WORDPRESS_DB_NAME: 'wordpress',
              WORDPRESS_DEBUG: '1',
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
            subnetType: ec2.SubnetType.PUBLIC,
          },
        },
      );

    loadBalancedFargateService.targetGroup.healthCheck = {
      path: '/wp-includes/images/blank.gif',
      interval: cdk.Duration.minutes(1),
    };

    database.connections.allowFrom(
      loadBalancedFargateService.cluster.connections,
      ec2.Port.tcp(3306),
    );

    loadBalancedFargateService.node.addDependency(database); // Ensure database is created first

    const scaling = loadBalancedFargateService.service.autoScaleTaskCount({
      maxCapacity: 3,
    });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
    });

    loadBalancedFargateService.targetGroup.configureHealthCheck({
      path: '/',
      interval: cdk.Duration.minutes(1),
    });

    const fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      encrypted: true,
    });

    fileSystem.node.addDependency(cluster);

    fileSystem.connections.allowFrom(
      autoScalingGroup.connections.connections,
      ec2.Port.tcp(2049),
    );

    const volumeName = 'efs';
    // volume can not be reached from the task definition ??
    // loadBalancedFargateService.taskDefinition.addVolume({
    //   name: volumeName,
    //   efsVolumeConfiguration: {
    //     fileSystemId: fileSystem.fileSystemId,

    //   },
    // });

    // loadBalancedFargateService.taskDefinition.defaultContainer?.addMountPoints({
    //   containerPath: '/var/www/html',
    //   readOnly: false,
    //   sourceVolume: volumeName,
    // });
  }
}
