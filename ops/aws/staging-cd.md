# Staging continuous delivery

The repository has one shared staging environment. CI runs automatically for pushes to `main` and
`feature/**`, and for pull requests. Deployment behavior is intentionally different by source:

- A successful `main` push starts staging CD automatically.
- A `feature/**` commit is deployed only through **Actions > Deploy staging > Run workflow**.
- Manual deployments can use `auto`, `frontend`, `backend`, or `both` scope.
- Amplify auto-build is disabled. GitHub Actions is the only web deployment owner.

The shared environment may intentionally contain components from different source branches. For
example, deploying a backend-only feature and then a frontend-only `main` change leaves the feature
backend alongside the `main` frontend.

## Change detection

For a `main` push, the workflow compares the pushed commit range. For a manual feature deployment,
`auto` compares the selected commit with its merge-base on `main`.

Backend deployment paths:

- `backend/sync-api/**`
- `ops/aws/ecs/task-definition.staging.json`

Frontend deployment paths:

- `src/**`
- `public/**`
- `index.html`
- `package.json` and `package-lock.json`
- `vite.config.ts` and `tsconfig.json`
- `.env.staging`
- `amplify.yml` and `customHttp.yml`
- `scripts/validate-production-config.mjs`

Changes outside these paths do not deploy application components. Use an explicit manual scope when
an indirect dependency is not represented by this list.

## Deployment gates

Both component jobs require a successful `CI` push run for the exact source commit. Deployments then
run as follows:

### Backend

1. Authenticate to AWS with a short-lived GitHub OIDC token.
2. Reuse the commit-tagged ECR image when present; otherwise build and push it.
3. Wait for ECR scanning and reject Critical or High findings.
4. Render the immutable digest into the ECS task definition.
5. Deploy ECS and wait for service stability.
6. Verify the active digest, public health response, and rollback alarm.

### Frontend

1. Confirm that Amplify auto-build is disabled.
2. Move the machine-managed Git branch `staging` to the selected source commit.
3. Start an Amplify `RELEASE` job for that branch.
4. Verify every referenced JavaScript and CSS asset has the expected MIME type.

The dedicated `staging` Git branch is necessary because an Amplify repository branch builds the
latest commit from its mapped Git branch. Developers must not commit directly to this branch.

## One-time AWS setup

The AWS account must have an IAM OpenID Connect provider with:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Create the GitHub deployment role and attach the repository-managed inline policy:

```powershell
$roleName = 'DearDiaryGitHubStagingDeployRole'

aws iam create-role `
  --role-name $roleName `
  --assume-role-policy-document file://ops/aws/iam/github-actions-staging-trust-policy.json

aws iam put-role-policy `
  --role-name $roleName `
  --policy-name DearDiaryStagingDeploy `
  --policy-document file://ops/aws/iam/github-actions-staging-permissions.json
```

The trust policy accepts tokens only from the `staging` GitHub environment. The permissions policy
can update only the existing ECS service, push to the sync API ECR repository, and start/inspect jobs
for the Amplify `staging` branch.

## One-time staging branch setup

Run these steps after this workflow is available on `main`:

1. Create the machine-managed Git branch from `main`:

   ```powershell
   git fetch origin main
   git push origin origin/main:refs/heads/staging
   ```

2. In Amplify, connect the repository branch named `staging` to app `d33b4rjnv35mrn`.
3. Disable auto-build for both `staging` and the old `feature/aws-deployment` Amplify branch.
4. Confirm the staging URL is `https://staging.d33b4rjnv35mrn.amplifyapp.com`.
5. Apply the updated IAM inline policy shown above.
6. Apply the repository-managed S3 CORS configuration:

   ```powershell
   aws s3api put-bucket-cors `
     --bucket dear-diary-sync-staging-908027418886 `
     --cors-configuration file://ops/aws/s3/cors.staging.json `
     --region ap-south-1
   ```

Do not enable branch protection that prevents GitHub Actions from force-updating the machine-managed
`staging` branch.

## One-time GitHub setup

Under **Repository settings > Environments > staging**:

1. Allow deployments from `main` and `feature/**`.
2. Keep `AWS_DEPLOY_ROLE_ARN` set to the staging deployment role ARN.

Under **Repository settings > Actions > General > Workflow permissions**:

1. Enable **Read and write permissions** so the web job can update the `staging` source branch.

## Operation

### Feature deployment

1. Push the feature commit and wait for CI to pass.
2. Open **Actions > Deploy staging > Run workflow**.
3. Select the feature branch and deployment scope.
4. Run the workflow and review its deployment summary.

### Main deployment

Push or merge to `main`. The deployment workflow starts automatically, waits for exact-commit CI,
and deploys only the components detected in that push.
