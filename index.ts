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
    "home": ["pulumi", "pulumi-aws", "pulumi-cloud" ],
}

const downstreamMap = computeDownstreamMap(dependencyMap);

// Given a dependency map (e.g. and object which for each key as an array of repositories it depends on), constructs
// a new map where each key is a repository and the values are the repositories "downstream", i.e. they consume the
// given repository either directly or indirectly.
function computeDownstreamMap(map: {[index: string]: string[]}) : {[index: string]: string[]} {
    const ret: {[index: string]: string[]} = {}

    for (let repo of Object.keys(map)) {
        const workQueue = [repo];
        const visted = new Set<string>();

        while (workQueue.length > 0) {
            let cur = workQueue.shift()!;

            if (!visted.has(cur)) {
                visted.add(cur);

                for (let repo2 of Object.keys(map)) {
                    if ((map[repo2]).indexOf(cur) >= 0) {
                        workQueue.push(repo2)
                    }
                }
            }
        }

        visted.delete(repo);
        ret[repo] = Array.from(visted);
    }

    return ret;
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
const ghToken = new pulumi.Config(pulumi.getProject()).require("ghToken");

const api = new serverless.apigateway.API("api", {
    routes: [
        {
            method: "POST",
            path: "/jobs",
            handler: async (req) => {
                const awssdk = await import("aws-sdk");
                const s3 = new awssdk.S3();

                const body = JSON.parse(req.isBase64Encoded ? Buffer.from(req.body, "base64").toString() : req.body);

                if (body.branch === undefined || body.repo === undefined) {
                    return {
                        statusCode: 400,
                        body: "missing branch or repo in request"
                    }
                }

                if (downstreamMap[body.repo] === undefined) {
                    return {
                        statusCode: 400,
                        body: "unknown repository"
                    }
                }

                const id = (new Date().valueOf()).toString();
                const repositories: {[key: string]: RepositoryInfo} = {}

                for (let repo of [body.repo].concat(downstreamMap[body.repo])) {
                    repositories[repo] = {
                        buildComplete: false,
                        ...await getBranchAndRef(repo, body.branch)
                    }

                    await s3.putObject({
                        ACL: "public-read",
                        Bucket: "public.eng.pulumi.com",
                        Key: `compose/build/${id}/commits/${repo}`,
                        Body: repositories[repo].sha
                    }).promise();
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
                const axios = await import("axios");
                const dynamo = new awssdk.DynamoDB.DocumentClient();

                const value = (await dynamo.get({
                    TableName: jobsTable.name.get(),
                    Key: { id: req.pathParameters.id }
                }).promise());

                const job = <JobData>value.Item!;

                for (let repo of Object.keys(job.repositories)) {
                    if (job.repositories[repo].travisBuild === undefined &&
                        job.repositories[repo].travisRequest !== undefined) {

                        const rsp = await axios.default.get(`https://api.travis-ci.com/repo/pulumi%2F${repo}/request/${job.repositories[repo].travisRequest}`,
                            {
                                headers: {
                                    "Content-Type": "application/json",
                                    "Travis-API-Version": "3",
                                    "Authorization": `token ${travisToken}`
                                }
                            });

                        if (rsp.data.builds !== undefined) {
                            await dynamo.update({
                                TableName: jobsTable.name.get(),
                                Key: { id: req.pathParameters.id },
                                UpdateExpression: `SET repositories.#repo.travisBuild = :travisBuild`,
                                ExpressionAttributeNames: {
                                    "#repo": repo
                                },
                                ExpressionAttributeValues: {
                                    ":travisBuild": rsp.data.builds[0].id
                                },
                                ReturnValues: "NONE"
                            }).promise();

                            job.repositories[repo].travisBuild = rsp.data.builds[0].id;
                        }
                    }
                }

                return {
                    statusCode: 200,
                    body: `${JSON.stringify(job, null, 2)}\n`,
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

async function getBranchAndRef(repo: string, branch: string) : Promise<{branch: string, sha: string}> {
    const octokit = new (await import("@octokit/rest"))();
    octokit.authenticate({type: "token", token: ghToken});

    let rsp = await octokit.gitdata.getReference({owner: "pulumi", repo: repo, ref: `heads/${branch}`});
    if (rsp.status == 200) {
        return { branch: branch, sha: rsp.data.object.sha }
    }

    rsp = await octokit.gitdata.getReference({owner: "pulumi", repo: repo, ref: `heads/master`});
    if (rsp.status == 200) {
        return { branch: "master", sha: rsp.data.object.sha }
    }

    throw new Error(`bad response from GitHub: ${rsp.status}`);
}

async function launchReadyLegs(job: JobData) : Promise<void> {
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
                                    "PULUMI_COMPOSE_BUILD_SHA": job.repositories[repo].sha,
                                    "PULUMI_COMPOSE_BUILD_ID": job.id
                                }
                            },
                            "script": `../scripts/compose/run-compose ${job.id}`
                        },
                        "message": "WIP: Composed Build",
                        "branch": job.repositories[repo].branch
                    }
                },
                {
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
    branch: string
    sha: string
    travisRequest?: string
    travisBuild?: string
}
