#!/usr/bin/env python3
"""
Analyze complete train journeys and route patterns
"""
import asyncio
import os
import psycopg
import pandas as pd

async def get_journey_analysis():
    """Analyze train journeys"""
    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://irish_data:secure_password@localhost:9898/ireland_public",
    )

    async with await psycopg.AsyncConnection.connect(db_url) as conn:
        # Most traveled routes (by origin-destination)
        cursor = await conn.execute("""
            SELECT
                train_origin as origin,
                train_destination as destination,
                COUNT(*) as journey_count,
                AVG(location_order)::INT as avg_stops,
                MAX(location_order) as max_stops
            FROM train_movements
            WHERE train_origin IS NOT NULL
              AND train_destination IS NOT NULL
              AND train_origin != ''
              AND train_destination != ''
            GROUP BY train_origin, train_destination
            ORDER BY journey_count DESC
            LIMIT 20
        """)

        rows = await cursor.fetchall()
        routes = [
            {'origin': row[0], 'destination': row[1], 'journey_count': row[2], 'avg_stops': row[3], 'max_stops': row[4]}
            for row in rows
        ]

        # Station connectivity - which stations are most connected
        cursor = await conn.execute("""
            WITH station_pairs AS (
                SELECT DISTINCT
                    train_origin as from_station,
                    train_destination as to_station
                FROM train_movements
                WHERE train_origin IS NOT NULL AND train_destination IS NOT NULL
                UNION
                SELECT DISTINCT
                    train_destination,
                    train_origin
                FROM train_movements
                WHERE train_origin IS NOT NULL AND train_destination IS NOT NULL
            )
            SELECT
                from_station,
                COUNT(*) as connected_to_count
            FROM station_pairs
            GROUP BY from_station
            ORDER BY connected_to_count DESC
            LIMIT 15
        """)

        rows = await cursor.fetchall()
        connectivity = [
            {'from_station': row[0], 'connected_to_count': row[1]}
            for row in rows
        ]

        # Average journey metrics
        cursor = await conn.execute("""
            SELECT
                train_origin,
                train_destination,
                AVG(location_order)::INT as avg_stops,
                COUNT(DISTINCT train_date || train_code) as unique_journeys
            FROM train_movements
            WHERE train_origin IS NOT NULL
              AND train_destination IS NOT NULL
            GROUP BY train_origin, train_destination
            ORDER BY unique_journeys DESC
            LIMIT 10
        """)

        rows = await cursor.fetchall()
        journey_metrics = [
            {'train_origin': row[0], 'train_destination': row[1], 'avg_stops': row[2], 'unique_journeys': row[3]}
            for row in rows
        ]

        return routes, connectivity, journey_metrics

async def main():
    routes, connectivity, journey_metrics = await get_journey_analysis()

    if not routes:
        print("No journey data yet - train movements may still be loading!")
        return

    print("\n" + "="*70)
    print("TOP 20 MOST TRAVELED ROUTES")
    print("="*70)
    df_routes = pd.DataFrame(routes)
    print(df_routes.to_string(index=False))

    print("\n" + "="*70)
    print("STATION CONNECTIVITY (Most Connected)")
    print("="*70)
    df_connectivity = pd.DataFrame(connectivity)
    print(df_connectivity.to_string(index=False))

    print("\n" + "="*70)
    print("JOURNEY METRICS")
    print("="*70)
    if journey_metrics:
        df_metrics = pd.DataFrame(journey_metrics)
        print(df_metrics.to_string(index=False))
    else:
        print("Insufficient data for journey metrics yet")

    # Summary stats
    print("\n" + "="*70)
    print("SUMMARY STATISTICS")
    print("="*70)
    print(f"Total unique routes: {len(df_routes)}")
    print(f"Most connected station: {df_connectivity.iloc[0]['from_station']} ({df_connectivity.iloc[0]['connected_to_count']} connections)")
    print(f"Busiest route: {df_routes.iloc[0]['origin']} → {df_routes.iloc[0]['destination']} ({df_routes.iloc[0]['journey_count']} journeys)")

if __name__ == "__main__":
    asyncio.run(main())
