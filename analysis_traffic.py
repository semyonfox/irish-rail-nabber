#!/usr/bin/env python3
"""
Analyze train traffic patterns - busiest stations and routes
"""
import asyncio
import os
from datetime import datetime, timedelta
import psycopg
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

async def get_traffic_data():
    """Fetch traffic statistics"""
    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://irish_data:secure_password@localhost:9898/ireland_public",
    )

    async with await psycopg.AsyncConnection.connect(db_url) as conn:
        # Most visited stations
        cursor = await conn.execute("""
            SELECT
                s.station_desc,
                COUNT(*) as event_count,
                COUNT(DISTINCT se.train_code) as unique_trains
            FROM station_events se
            JOIN stations s ON se.station_code = s.station_code
            GROUP BY s.station_desc
            ORDER BY event_count DESC
            LIMIT 25
        """)

        rows = await cursor.fetchall()
        stations = [
            {'station_desc': row[0], 'event_count': row[1], 'unique_trains': row[2]}
            for row in rows
        ]

        # Most common routes
        cursor = await conn.execute("""
            SELECT
                origin,
                destination,
                COUNT(*) as route_count,
                COUNT(DISTINCT train_code) as unique_trains
            FROM station_events
            WHERE origin IS NOT NULL
              AND destination IS NOT NULL
              AND origin != ''
              AND destination != ''
            GROUP BY origin, destination
            ORDER BY route_count DESC
            LIMIT 15
        """)

        rows = await cursor.fetchall()
        routes = [
            {'origin': row[0], 'destination': row[1], 'route_count': row[2], 'unique_trains': row[3]}
            for row in rows
        ]
        return stations, routes

async def main():
    stations, routes = await get_traffic_data()

    if not stations:
        print("No traffic data yet!")
        return

    print("\n" + "="*70)
    print("TOP 25 BUSIEST STATIONS")
    print("="*70)
    df_stations = pd.DataFrame(stations)
    print(df_stations.to_string(index=False))

    print("\n" + "="*70)
    print("TOP 15 MOST COMMON ROUTES")
    print("="*70)
    df_routes = pd.DataFrame(routes)
    print(df_routes.to_string(index=False))

    # Visualizations
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 8))

    # Busiest stations
    df_top = df_stations.head(15).sort_values('event_count', ascending=True)
    ax1.barh(df_top['station_desc'], df_top['event_count'], color='teal')
    ax1.set_xlabel('Number of Events')
    ax1.set_title('Top 15 Busiest Stations')
    ax1.invert_yaxis()

    # Most common routes
    df_routes['route'] = df_routes['origin'] + ' → ' + df_routes['destination']
    df_route_top = df_routes.head(12).sort_values('route_count', ascending=True)
    ax2.barh(df_route_top['route'], df_route_top['route_count'], color='orange')
    ax2.set_xlabel('Number of Trains')
    ax2.set_title('Top 12 Most Common Routes')
    ax2.invert_yaxis()

    plt.tight_layout()
    plt.savefig('/tmp/irish_rail_traffic.png', dpi=150, bbox_inches='tight')
    print("\n✅ Chart saved to /tmp/irish_rail_traffic.png")

if __name__ == "__main__":
    asyncio.run(main())
