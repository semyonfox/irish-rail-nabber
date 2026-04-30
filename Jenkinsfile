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
    DOCKER_BUILDKIT         = '1'
    COMPOSE_PROJECT_NAME    = 'irish-rail-nabber'
    CLOUDFLARE_TUNNEL_TOKEN = credentials('cloudflare-tunnel-token')
    JWT_SECRET              = credentials('irish-rail-jwt-secret')
  }

  stages {
    stage('Checkout') {
      steps {
        checkout([
          $class: 'GitSCM',
          branches: [[name: '*/main']],
          userRemoteConfigs: [[url: 'https://github.com/semyonfox/irish-rail-nabber.git']]
        ])
      }
    }

    stage('Build') {
      parallel {
        stage('Daemon') {
          steps {
            sh 'docker build -t irish-rail-nabber-daemon:latest .'
          }
        }
        stage('API') {
          steps {
            sh 'docker build -t irish-rail-nabber-api:latest ./api'
          }
        }
        stage('Dashboard') {
          steps {
            sh 'docker build -t irish-rail-nabber-dashboard:latest ./dashboard'
          }
        }
      }
    }

    stage('Deploy') {
      steps {
        sh '''
          docker compose up -d --no-build
          docker compose ps
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
