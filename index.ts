import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as serverless from "@pulumi/aws-serverless";

const dependencyMap: {[index: string]: string[]} = {
    "pulumi": [],
    "pulumi-terraform": ["pulumi"],
    "pulumi-aws": ["pulumi", "pulumi-terraform"],
    "pulumi-aws-infra": ["pulumi", "pulumi-aws"],
    "pulumi-aws-serverless": ["pulumi", "pulumi-aws"],
    "pulumi-cloud": ["pulumi", "pulumi-aws", "pulumi-aws-infra" ],
}

const jobsTable = new aws.dynamodb.Table("jobsTable", {
    attributes: [{
        name: "id",
        type: "S"
    }],
    hashKey: "id",
    readCapacity: 5,
    writeCapacity: 5,
});

const travisToken = new pulumi.Config(pulumi.getProject()).require("travisToken");

const api = new serverless.apigateway.API("api", {
    routes: [
        {
            method: "POST",
            path: "/jobs",
            handler: async (req) => {
                const id = (new Date().valueOf()).toString();
                const repositories: {[key: string]: RepositoryInfo} = {}

                for (let repo of Object.keys(dependencyMap)) {
                    repositories[repo] = {
                        buildComplete: false,
                    }
                }

                const job = {
                    id: id,
                    repositories: repositories,
                }

                await launchReadyLegs(job);

                return {
                    statusCode: 200,
                    body: `${JSON.stringify(job, null, 2)}\n`
                }
            },
        },
        {
            method: "GET",
            path: "/job/{id}",
            handler: async (req) => {
                const awssdk = await import("aws-sdk");
                const dynamo = new awssdk.DynamoDB.DocumentClient();

                const value = await dynamo.get({
                    TableName: jobsTable.name.get(),
                    Key: { id: req.pathParameters.id }
                }).promise();

                return {
                    statusCode: 200,
                    body: `${JSON.stringify(value.Item, null, 2)}\n`,
                };
            },
        },
        {
            method: "POST",
            path: "/job/{id}/build-complete/{repo}",
            handler: async (req) => {
                const awssdk = await import("aws-sdk");
                const dynamo = new awssdk.DynamoDB.DocumentClient();

                const id = req.pathParameters.id;
                const repo = req.pathParameters.repo;

                console.log(`[${id}] marking build complete for ${repo}`)

                const res = await dynamo.update({
                    TableName: jobsTable.name.get(),
                    Key: { id: req.pathParameters.id },
                    UpdateExpression: `SET repositories.#repo.buildComplete = :buildComplete`,
                    ExpressionAttributeNames: {
                        "#repo": req.pathParameters.repo
                    },
                    ExpressionAttributeValues: {
                        ":buildComplete": true
                    },
                    ReturnValues: "ALL_NEW"
                }).promise();

                console.log(`[${id}] build marked as completed for ${repo}`);

                const job = <JobData>res.Attributes!;

                await launchReadyLegs(job);

                return {
                    statusCode: 200, body: `${JSON.stringify(job, null, 2)}\n`
                }
            }
        },
    ]
});

async function launchReadyLegs(job: JobData) {
    const awssdk = await import("aws-sdk");
    const axios = await import("axios");
    const dynamo = new awssdk.DynamoDB.DocumentClient();

    for (let repo of Object.keys(job.repositories)) {
        if (job.repositories[repo].travisRequest === undefined) {
            let ready = true;
            for (let dep of dependencyMap[repo]) {
                ready = ready && job.repositories[dep].buildComplete;
            }

            if (ready) {
                console.log(`[${job.id}] launching travis build for ${repo}`);

                const rsp = await axios.default.post(`https://api.travis-ci.com/repo/pulumi%2F${repo}/requests`,
                {
                    "request": {
                        "config": {
                            "merge_mode": "deep_merge",
                            "env": {
                                "global": {
                                    "PULUMI_COMPOSED_BUILD": true
                                }
                            },
                            "script": `../scripts/compose/run-compose ${job.id}`
                        },
                        "message": "WIP: Composed Build",
                        "branch": "feature/ellismg/compose-build"
                    }
                },
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Travis-API-Version": "3",
                        "Authorization": `token ${travisToken}`
                    }
                });

                console.log(`[${job.id}] launched travis build for ${repo} with id=${rsp.data.request.id} (rate limit: ${rsp.data.remaining_requests - 1} remaining)`);
                job.repositories[repo].travisRequest = rsp.data.request.id;
            }
        }
    }

    await dynamo.put({
        TableName: jobsTable.name.get(),
        Item: job
    }).promise();
}

export const url = api.url;

type JobData = {
    id: string,
    repositories: {
        [key: string]: RepositoryInfo
    }
}

type RepositoryInfo = {
    buildComplete: boolean
    travisRequest?: string
}