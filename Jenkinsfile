pipeline {
  agent { label 'docker-agent' }

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  triggers {
    githubPush()
  }

  environment {
    APP_REPO = 'https://github.com/semyonfox/irish-rail-nabber.git'
    APP_BRANCH = 'main'
    STACK_DIR = '/home/semyon/server-stacks/irish-rail'
    CACHE_ROOT = '/home/jenkins/cache/buildkit'
    DAEMON_IMAGE_REPO = 'irish-rail-nabber-daemon'
    API_IMAGE_REPO = 'irish-rail-nabber-api'
    DASHBOARD_IMAGE_REPO = 'irish-rail-nabber-dashboard'
    CANDIDATE_SUBNET = '10.254.40.0/28'
  }

  stages {
    stage('Checkout App') {
      steps {
        checkout([
          $class: 'GitSCM',
          branches: [[name: "*/${env.APP_BRANCH}"]],
          userRemoteConfigs: [[url: env.APP_REPO, credentialsId: 'github-pat']]
        ])
      }
    }

    stage('Require GitHub CI') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'github-pat', usernameVariable: 'GITHUB_USERNAME', passwordVariable: 'GITHUB_TOKEN')]) {
          sh '''
            GITHUB_REPOSITORY=semyonfox/irish-rail-nabber \
            GITHUB_REQUIRED_CHECKS='Python scripts,Repository hygiene,Dashboard,Rust API' \
              /home/semyon/server-stacks/jenkins/scripts/wait-for-github-ci.sh
          '''
        }
      }
    }

    stage('Verify Buildx builder') {
      steps {
        sh '''
          set -eu
          docker buildx inspect jenkins-cache --bootstrap | grep -Eq '^Driver:[[:space:]]+docker-container$'
        '''
      }
    }

    stage('Build images') {
      parallel {
        stage('Daemon') {
          steps {
            sh '''
              set -eu
              SHORT_COMMIT=$(git rev-parse --short=7 HEAD)
              IMAGE="${DAEMON_IMAGE_REPO}:${SHORT_COMMIT}"
              CACHE_DIR="${CACHE_ROOT}/irish-rail-prod-daemon"

              rm -rf "${CACHE_DIR}-new"
              mkdir -p "$CACHE_DIR"
              docker buildx build --builder jenkins-cache --load \
                --cache-from type=local,src="$CACHE_DIR" \
                --cache-to type=local,dest="${CACHE_DIR}-new",mode=max \
                --label app=irish-rail-nabber-daemon \
                --label environment=prod \
                --label git-commit="$(git rev-parse HEAD)" \
                --label jenkins-build="$BUILD_TAG" \
                -t "$IMAGE" .
              rm -rf "$CACHE_DIR"
              mv "${CACHE_DIR}-new" "$CACHE_DIR"
              docker tag "$IMAGE" "${DAEMON_IMAGE_REPO}:latest"
            '''
          }
        }
        stage('API') {
          steps {
            sh '''
              set -eu
              SHORT_COMMIT=$(git rev-parse --short=7 HEAD)
              IMAGE="${API_IMAGE_REPO}:${SHORT_COMMIT}"
              CACHE_DIR="${CACHE_ROOT}/irish-rail-prod-api"

              rm -rf "${CACHE_DIR}-new"
              mkdir -p "$CACHE_DIR"
              docker buildx build --builder jenkins-cache --load \
                --cache-from type=local,src="$CACHE_DIR" \
                --cache-to type=local,dest="${CACHE_DIR}-new",mode=max \
                --label app=irish-rail-nabber-api \
                --label environment=prod \
                --label git-commit="$(git rev-parse HEAD)" \
                --label jenkins-build="$BUILD_TAG" \
                -t "$IMAGE" ./api
              rm -rf "$CACHE_DIR"
              mv "${CACHE_DIR}-new" "$CACHE_DIR"
              docker tag "$IMAGE" "${API_IMAGE_REPO}:latest"
            '''
          }
        }
        stage('Dashboard') {
          steps {
            sh '''
              set -eu
              SHORT_COMMIT=$(git rev-parse --short=7 HEAD)
              IMAGE="${DASHBOARD_IMAGE_REPO}:${SHORT_COMMIT}"
              CACHE_DIR="${CACHE_ROOT}/irish-rail-prod-dashboard"

              rm -rf "${CACHE_DIR}-new"
              mkdir -p "$CACHE_DIR"
              docker buildx build --builder jenkins-cache --load \
                --cache-from type=local,src="$CACHE_DIR" \
                --cache-to type=local,dest="${CACHE_DIR}-new",mode=max \
                --label app=irish-rail-nabber-dashboard \
                --label environment=prod \
                --label git-commit="$(git rev-parse HEAD)" \
                --label jenkins-build="$BUILD_TAG" \
                -t "$IMAGE" ./dashboard
              rm -rf "$CACHE_DIR"
              mv "${CACHE_DIR}-new" "$CACHE_DIR"
              docker tag "$IMAGE" "${DASHBOARD_IMAGE_REPO}:latest"
            '''
          }
        }
      }
    }

    stage('Candidate smoke') {
      steps {
        sh '''
          set -eu
          SHORT_COMMIT=$(git rev-parse --short=7 HEAD)
          DAEMON_IMAGE="${DAEMON_IMAGE_REPO}:${SHORT_COMMIT}"
          API_IMAGE="${API_IMAGE_REPO}:${SHORT_COMMIT}"
          DASHBOARD_IMAGE="${DASHBOARD_IMAGE_REPO}:${SHORT_COMMIT}"
          NETWORK="irish-rail-nabber-candidate-${BUILD_NUMBER}"
          DB_CANDIDATE="irish-rail-db-candidate-${BUILD_NUMBER}"
          MIGRATE_CANDIDATE="irish-rail-migrate-candidate-${BUILD_NUMBER}"
          DAEMON_CANDIDATE="irish-rail-daemon-candidate-${BUILD_NUMBER}"
          API_CANDIDATE="irish-rail-api-candidate-${BUILD_NUMBER}"
          DASHBOARD_CANDIDATE="irish-rail-dashboard-candidate-${BUILD_NUMBER}"

          cleanup_candidate() {
            docker rm -fv "$DASHBOARD_CANDIDATE" "$API_CANDIDATE" "$DAEMON_CANDIDATE" "$MIGRATE_CANDIDATE" "$DB_CANDIDATE" >/dev/null 2>&1 || true
            docker network rm "$NETWORK" >/dev/null 2>&1 || true
          }
          trap cleanup_candidate EXIT

          cleanup_candidate
          # Reserve a small test subnet because the shared host's default pools are full.
          docker network create --subnet "$CANDIDATE_SUBNET" "$NETWORK" >/dev/null
          docker run -d --name "$DB_CANDIDATE" \
            --network "$NETWORK" \
            --network-alias db \
            --restart no \
            -e POSTGRES_USER=candidate \
            -e POSTGRES_PASSWORD=candidate-db-password \
            -e POSTGRES_DB=candidate \
            timescale/timescaledb:2.25.2-pg18 >/dev/null

          for attempt in $(seq 1 30); do
            if docker exec "$DB_CANDIDATE" pg_isready -U candidate -d candidate >/dev/null 2>&1; then
              break
            fi
            if [ "$attempt" -eq 30 ]; then
              docker logs "$DB_CANDIDATE" || true
              exit 1
            fi
            sleep 1
          done

          timeout 180 docker run --rm --name "$MIGRATE_CANDIDATE" \
            --network "$NETWORK" \
            -e DATABASE_URL=postgresql://candidate:candidate-db-password@db:5432/candidate \
            "$DAEMON_IMAGE" /bin/true

          docker run --rm --entrypoint python "$DAEMON_IMAGE" \
            -m py_compile /app/daemon.py /app/bus_daemon.py

          docker run -d --name "$DAEMON_CANDIDATE" \
            --network "$NETWORK" \
            --restart no \
            -e DATABASE_URL=postgresql://candidate:candidate-db-password@db:5432/candidate \
            -e SKIP_DB_MIGRATIONS=1 \
            -e POSTGRES_USER=candidate \
            -e POSTGRES_PASSWORD=candidate-db-password \
            -e POSTGRES_DB=candidate \
            "$DAEMON_IMAGE" >/dev/null

          for attempt in $(seq 1 45); do
            if [ "$(docker inspect -f '{{.State.Running}}' "$DAEMON_CANDIDATE")" = true ] \
              && docker logs "$DAEMON_CANDIDATE" 2>&1 | grep -Fq 'Starting process...'; then
              break
            fi
            if [ "$attempt" -eq 45 ]; then
              docker logs "$DAEMON_CANDIDATE" || true
              exit 1
            fi
            sleep 2
          done

          docker run -d --name "$API_CANDIDATE" \
            --network "$NETWORK" \
            --network-alias api \
            --restart no \
            -e DATABASE_URL=postgresql://candidate:candidate-db-password@db:5432/candidate \
            "$API_IMAGE" >/dev/null
          docker run -d --name "$DASHBOARD_CANDIDATE" \
            --network "$NETWORK" \
            --restart no \
            "$DASHBOARD_IMAGE" >/dev/null

          candidate_bus_graphql_ready() {
            response=$(docker exec "$API_CANDIDATE" curl -fsS \
              -H 'content-type: application/json' \
              --data '{"query":"{ busStops(limit: 1) { stopId } busVehicles(limit: 1) { vehicleId } busRouteDelays(hours: 1, limit: 1) { routeId } }"}' \
              http://127.0.0.1:8000/graphql) || return 1
            case "$response" in
              *'"errors"'*) return 1 ;;
            esac
            printf '%s' "$response" | grep -Fq '"busStops":[]' \
              && printf '%s' "$response" | grep -Fq '"busVehicles":[]' \
              && printf '%s' "$response" | grep -Fq '"busRouteDelays":[]'
          }

          for attempt in $(seq 1 30); do
            if docker exec "$API_CANDIDATE" curl -fsS http://127.0.0.1:8000/health >/dev/null \
              && docker exec "$API_CANDIDATE" curl -fsS http://127.0.0.1:8000/auth/config | grep -Fq '"billing_enabled":false' \
              && docker exec "$DASHBOARD_CANDIDATE" wget -qO- http://127.0.0.1/ >/dev/null \
              && candidate_bus_graphql_ready; then
              echo "[candidate] all Irish Rail services are healthy in an isolated network"
              exit 0
            fi
            if [ "$attempt" -eq 30 ]; then
              docker logs "$API_CANDIDATE" || true
              docker logs "$DASHBOARD_CANDIDATE" || true
              exit 1
            fi
            sleep 1
          done
        '''
      }
    }

    stage('Deploy with rollback') {
      steps {
        sh '''
          set -eu
          SHORT_COMMIT=$(git rev-parse --short=7 HEAD)
          cd "$STACK_DIR"
          compose() {
            docker compose --env-file stack.env -f stack.yaml "$@"
          }

          capture_previous_image() {
            service="$1"
            repository="$2"
            container=$(compose ps -q "$service" || true)
            if [ -z "$container" ]; then
              return 0
            fi
            image=$(docker inspect -f '{{.Image}}' "$container")
            docker tag "$image" "${repository}:rollback-${BUILD_NUMBER}"
            printf '%s' "$image"
          }

          PREVIOUS_DAEMON_IMAGE=$(capture_previous_image daemon "$DAEMON_IMAGE_REPO")
          PREVIOUS_API_IMAGE=$(capture_previous_image api "$API_IMAGE_REPO")
          PREVIOUS_DASHBOARD_IMAGE=$(capture_previous_image dashboard "$DASHBOARD_IMAGE_REPO")
          PREVIOUS_BUS_DAEMON=$(compose ps -q bus-daemon || true)

          restore_previous_tags() {
            if [ -n "$PREVIOUS_DAEMON_IMAGE" ]; then
              docker tag "$PREVIOUS_DAEMON_IMAGE" "${DAEMON_IMAGE_REPO}:latest"
            fi
            if [ -n "$PREVIOUS_API_IMAGE" ]; then
              docker tag "$PREVIOUS_API_IMAGE" "${API_IMAGE_REPO}:latest"
            fi
            if [ -n "$PREVIOUS_DASHBOARD_IMAGE" ]; then
              docker tag "$PREVIOUS_DASHBOARD_IMAGE" "${DASHBOARD_IMAGE_REPO}:latest"
            fi
          }

          rollback() {
            echo "[rollback] restoring the previously running Irish Rail images"
            restore_previous_tags
            if [ -n "$PREVIOUS_BUS_DAEMON" ]; then
              compose up -d --no-build --no-deps --force-recreate daemon bus-daemon api dashboard
            else
              compose stop bus-daemon >/dev/null 2>&1 || true
              compose rm -f bus-daemon >/dev/null 2>&1 || true
              compose up -d --no-build --no-deps --force-recreate daemon api dashboard
            fi
          }

          daemon_ready() {
            daemon_container=$(compose ps -q daemon || true)
            [ -n "$daemon_container" ] && \
              [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$daemon_container")" = healthy ]
          }

          bus_daemon_ready() {
            bus_container=$(compose ps -q bus-daemon || true)
            [ -n "$bus_container" ] && \
              [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$bus_container")" = healthy ]
          }

          static_feed_ready() {
            compose exec -T db psql -U irish_data -d ireland_public -tAc \
              "SELECT EXISTS (SELECT 1 FROM transit_feed_versions WHERE source = 'nta_gtfs' AND is_active AND imported_at IS NOT NULL)" \
              | grep -Fqx t
          }

          static_bus_api_ready() {
            response=$(compose exec -T api curl -fsS \
              -H 'content-type: application/json' \
              --data '{"query":"{ busStops(limit: 1) { stopId } }"}' \
              http://127.0.0.1:8000/graphql) || return 1
            case "$response" in
              *'"errors"'*) return 1 ;;
            esac
            printf '%s' "$response" | grep -Fq '"busStops":[{'
          }

          realtime_feed_ready() {
            compose exec -T db psql -U irish_data -d ireland_public -tAc \
              "SELECT EXISTS (SELECT 1 FROM fetch_history WHERE endpoint = 'nta_trip_updates' AND status = 'success' AND fetched_at > NOW() - INTERVAL '5 minutes')" \
              | grep -Fqx t
          }

          if ! timeout 180 docker compose --env-file stack.env -f stack.yaml \
            run --rm --no-deps migrate; then
            restore_previous_tags
            exit 1
          fi

          if ! compose up -d --no-build --no-deps --force-recreate daemon bus-daemon api dashboard; then
            rollback
            exit 1
          fi

          for attempt in $(seq 1 45); do
            if compose exec -T api curl -fsS http://127.0.0.1:8000/health >/dev/null \
              && compose exec -T dashboard wget -qO- http://127.0.0.1/ >/dev/null \
              && daemon_ready \
              && bus_daemon_ready; then
              for public_attempt in $(seq 1 30); do
                if curl -fsS https://traein.semyon.ie/health >/dev/null \
                  && curl -fsS https://traein.semyon.ie/ >/dev/null; then
                  break
                fi
                if [ "$public_attempt" -eq 30 ]; then
                  echo "[deploy] public smoke failed; rolling back" >&2
                  rollback
                  exit 1
                fi
                sleep 2
              done
              compose ps

              for bus_attempt in $(seq 1 120); do
                if static_feed_ready && static_bus_api_ready; then
                  break
                fi
                if [ "$bus_attempt" -eq 120 ]; then
                  echo "[deploy] NTA static feed/API did not become ready; rolling back" >&2
                  compose logs --tail=100 bus-daemon || true
                  rollback
                  exit 1
                fi
                sleep 10
              done

              if compose exec -T bus-daemon sh -c 'test -n "$NTA_API_KEY"'; then
                for realtime_attempt in $(seq 1 36); do
                  if realtime_feed_ready; then
                    break
                  fi
                  if [ "$realtime_attempt" -eq 36 ]; then
                    echo "[deploy] NTA realtime feed is not fresh; rolling back" >&2
                    compose logs --tail=100 bus-daemon || true
                    rollback
                    exit 1
                  fi
                  sleep 10
                done
              else
                echo "[deploy] NTA_API_KEY is absent; bus service is static-only"
              fi

              docker image rm \
                "${DAEMON_IMAGE_REPO}:rollback-${BUILD_NUMBER}" \
                "${API_IMAGE_REPO}:rollback-${BUILD_NUMBER}" \
                "${DASHBOARD_IMAGE_REPO}:rollback-${BUILD_NUMBER}" \
                >/dev/null 2>&1 || true
              echo "[deploy] Irish Rail images for ${SHORT_COMMIT} are healthy"
              exit 0
            fi
            if [ "$attempt" -eq 45 ]; then
              echo "[deploy] final smoke failed; rolling back" >&2
              rollback
              exit 1
            fi
            sleep 2
          done
        '''
      }
    }
  }

  post {
    always {
      script {
        if (env.NODE_NAME) {
          deleteDir()
        } else {
          echo 'No agent workspace was allocated; skipping workspace cleanup'
        }
      }
    }
  }
}
