#!/bin/sh
set -e
service=$1
docker-compose stop $service
docker-compose rm -f $service
docker-compose stop $service-create
docker-compose rm -f $service-create
docker-compose up -d $service-create
echo "Service was started"
sidekick_container=$(docker-compose ps --quiet $service-create)
docker wait $sidekick_container
echo "Setup is now complete"
