pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    timestamps()
  }

  triggers {
    githubPush()
  }

  environment {
    IMAGE_NAME = 'irish-rail-nabber-daemon'
    CONTAINER_NAME = 'irish_rail_daemon'
    NETWORK = 'irish-rail-nabber_default'
  }

  stages {
    stage('Checkout') {
      steps {
        checkout([
          $class: 'GitSCM',
          branches: [[name: '*/master']],
          userRemoteConfigs: [[url: 'https://github.com/semyonfox/irish-rail-nabber.git']]
        ])
      }
    }

    stage('Deploy') {
      steps {
        sh '''
          docker build -t "$IMAGE_NAME:latest" .
          docker rm -f "$CONTAINER_NAME" || true
          docker run -d \
            --name "$CONTAINER_NAME" \
            --network "$NETWORK" \
            --restart unless-stopped \
            -e DATABASE_URL=postgresql://irish_data:secure_password@irish_rail_db:5432/ireland_public \
            "$IMAGE_NAME:latest"
          sleep 10
          docker inspect "$CONTAINER_NAME" --format '{{.State.Status}}' | grep -q running
        '''
      }
    }
  }

  post {
    always {
      deleteDir()
    }
  }
}
