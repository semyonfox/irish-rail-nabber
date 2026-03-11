FROM python:3.11-slim

RUN apt-get update && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -v -r requirements.txt

COPY schema.sql .
COPY daemon.py .
COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

ENV POSTGRES_USER=irish_data
ENV POSTGRES_PASSWORD=secure_password
ENV POSTGRES_DB=ireland_public
ENV DATABASE_URL=postgresql://irish_data:secure_password@db:5432/ireland_public

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["python", "daemon.py"]
