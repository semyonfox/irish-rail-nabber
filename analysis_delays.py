#!/usr/bin/env python3
"""
Analyze train delays by station and time of day
"""
import asyncio
import os
from datetime import datetime, timedelta
import psycopg
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

async def get_delays():
    """Fetch delay data from database"""
    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://irish_data:secure_password@localhost:9898/ireland_public",
    )

    async with await psycopg.AsyncConnection.connect(db_url) as conn:
        # Get delays by station
        cursor = await conn.execute("""
            SELECT
                s.station_desc,
                AVG(COALESCE(se.late_minutes, 0)) as avg_delay,
                MAX(COALESCE(se.late_minutes, 0)) as max_delay,
                COUNT(*) as event_count
            FROM station_events se
            JOIN stations s ON se.station_code = s.station_code
            WHERE se.late_minutes IS NOT NULL
            GROUP BY s.station_desc
            ORDER BY avg_delay DESC
            LIMIT 20
        """)

        rows = await cursor.fetchall()
        data = [
            {
                'station_desc': row[0],
                'avg_delay': int(row[1]) if row[1] else 0,
                'max_delay': row[2] if row[2] else 0,
                'event_count': row[3]
            }
            for row in rows
        ]
        return data

async def main():
    delays = await get_delays()

    if not delays:
        print("No delay data yet!")
        return

    df = pd.DataFrame(delays)

    print("\n" + "="*70)
    print("TOP 20 STATIONS BY AVERAGE DELAY")
    print("="*70)
    print(df.to_string(index=False))

    # Create visualization
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 6))

    # Average delays
    df_sorted = df.sort_values('avg_delay', ascending=True)
    ax1.barh(df_sorted['station_desc'], df_sorted['avg_delay'], color='coral')
    ax1.set_xlabel('Average Delay (minutes)')
    ax1.set_title('Average Train Delays by Station')
    ax1.invert_yaxis()

    # Max delays
    df_sorted2 = df.sort_values('max_delay', ascending=True)
    ax2.barh(df_sorted2['station_desc'], df_sorted2['max_delay'], color='steelblue')
    ax2.set_xlabel('Max Delay (minutes)')
    ax2.set_title('Maximum Train Delays by Station')
    ax2.invert_yaxis()

    plt.tight_layout()
    plt.savefig('/tmp/irish_rail_delays.png', dpi=150, bbox_inches='tight')
    print("\n✅ Chart saved to /tmp/irish_rail_delays.png")

if __name__ == "__main__":
    asyncio.run(main())
