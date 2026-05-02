# GuardTrail API

A Node.js/Express REST API for the GuardTrail crowdsourced trail conditions app.

## Tech stack
- Node.js + Express
- PostgreSQL + PostGIS (Amazon RDS)
- Amazon ECS Fargate
- Amazon Cognito (JWT authentication)
- Docker

## Endpoints
- GET /api/reports — fetch all active trail reports
- POST /api/reports — submit a new report (auth required)
- PUT /api/reports/:id — update a report (auth required)
- DELETE /api/reports/:id — resolve or delete a report (auth required)
- GET /health — health check

## Deployment
Containerized with Docker and deployed to AWS ECS Fargate behind
an Application Load Balancer.
