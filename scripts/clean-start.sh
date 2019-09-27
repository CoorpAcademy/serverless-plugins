#!/bin/bash
set -e
service=$1
root=$( cd "$(dirname "${BASH_SOURCE[0]}")/.." ; pwd -P )
function dc () {
    (cd $root && docker-compose -f docker-compose.test.yml $@)
}

dc stop $service
dc rm -f $service
dc stop $service-create
dc rm -f $service-create
dc up -d $service-create
echo "> Service $service was started"
sidekick_container=$(dc ps --quiet $service-create)
docker wait $sidekick_container > /dev/null
echo "> Setup of $service is now complete"
