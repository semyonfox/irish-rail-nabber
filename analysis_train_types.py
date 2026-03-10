#!/usr/bin/env python3
"""
Analyze train types and their performance characteristics
"""
import asyncio
import os
import psycopg
import pandas as pd
import matplotlib.pyplot as plt

async def get_train_analysis():
    """Analyze train types and their performance"""
    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://irish_data:secure_password@localhost:9898/ireland_public",
    )

    async with await psycopg.AsyncConnection.connect(db_url) as conn:
        # Train type analysis
        cursor = await conn.execute("""
            SELECT
                train_type,
                COUNT(*) as event_count,
                AVG(COALESCE(late_minutes, 0))::INT as avg_delay,
                MAX(COALESCE(late_minutes, 0)) as max_delay,
                COUNT(DISTINCT train_code) as unique_trains
            FROM station_events
            WHERE train_type IS NOT NULL AND train_type != ''
            GROUP BY train_type
            ORDER BY event_count DESC
        """)

        rows = await cursor.fetchall()
        train_types = [
            {'train_type': row[0], 'event_count': row[1], 'avg_delay': row[2], 'max_delay': row[3], 'unique_trains': row[4]}
            for row in rows
        ]

        # Direction analysis
        cursor = await conn.execute("""
            SELECT
                direction,
                COUNT(*) as event_count,
                COUNT(DISTINCT train_code) as unique_trains,
                COUNT(DISTINCT station_code) as stations_visited
            FROM station_events
            WHERE direction IS NOT NULL AND direction != ''
            GROUP BY direction
            ORDER BY event_count DESC
        """)

        rows = await cursor.fetchall()
        directions = [
            {'direction': row[0], 'event_count': row[1], 'unique_trains': row[2], 'stations_visited': row[3]}
            for row in rows
        ]

        # Status breakdown
        cursor = await conn.execute("""
            SELECT
                status,
                COUNT(*) as count
            FROM station_events
            WHERE status IS NOT NULL AND status != ''
            GROUP BY status
            ORDER BY count DESC
        """)

        rows = await cursor.fetchall()
        statuses = [
            {'status': row[0], 'count': row[1]}
            for row in rows
        ]

        return train_types, directions, statuses

async def main():
    train_types, directions, statuses = await get_train_analysis()

    if not train_types:
        print("No analysis data yet!")
        return

    print("\n" + "="*70)
    print("TRAIN TYPE PERFORMANCE ANALYSIS")
    print("="*70)
    df_types = pd.DataFrame(train_types)
    print(df_types.to_string(index=False))

    print("\n" + "="*70)
    print("DIRECTION ANALYSIS")
    print("="*70)
    df_directions = pd.DataFrame(directions)
    print(df_directions.to_string(index=False))

    print("\n" + "="*70)
    print("TRAIN STATUS BREAKDOWN")
    print("="*70)
    df_statuses = pd.DataFrame(statuses)
    print(df_statuses.to_string(index=False))

    # Create visualizations
    fig = plt.figure(figsize=(16, 10))
    gs = fig.add_gridspec(2, 2, hspace=0.3, wspace=0.3)

    # Train types by volume
    ax1 = fig.add_subplot(gs[0, 0])
    df_types_sorted = df_types.sort_values('event_count', ascending=True)
    ax1.barh(df_types_sorted['train_type'], df_types_sorted['event_count'], color='skyblue')
    ax1.set_xlabel('Event Count')
    ax1.set_title('Train Type Distribution')
    ax1.invert_yaxis()

    # Train types by delay
    ax2 = fig.add_subplot(gs[0, 1])
    df_types_delay = df_types[df_types['avg_delay'] > 0].sort_values('avg_delay', ascending=True)
    if not df_types_delay.empty:
        ax2.barh(df_types_delay['train_type'], df_types_delay['avg_delay'], color='salmon')
        ax2.set_xlabel('Average Delay (minutes)')
        ax2.set_title('Average Delays by Train Type')
        ax2.invert_yaxis()

    # Directions
    ax3 = fig.add_subplot(gs[1, 0])
    df_directions_sorted = df_directions.sort_values('event_count', ascending=True)
    ax3.barh(df_directions_sorted['direction'], df_directions_sorted['event_count'], color='lightgreen')
    ax3.set_xlabel('Event Count')
    ax3.set_title('Direction Distribution')
    ax3.invert_yaxis()

    # Status breakdown (pie chart)
    ax4 = fig.add_subplot(gs[1, 1])
    colors = ['#ff9999', '#66b3ff', '#99ff99', '#ffcc99', '#ff99cc']
    ax4.pie(df_statuses['count'], labels=df_statuses['status'], autopct='%1.1f%%',
            colors=colors[:len(df_statuses)], startangle=90)
    ax4.set_title('Train Status Distribution')

    plt.savefig('/tmp/irish_rail_train_analysis.png', dpi=150, bbox_inches='tight')
    print("\n✅ Chart saved to /tmp/irish_rail_train_analysis.png")

if __name__ == "__main__":
    asyncio.run(main())
