#!/usr/bin/env python3
"""
Fetch train journey data from Irish Rail API.
Saves journey information with all stops and timings.
"""

import requests
import xml.etree.ElementTree as ET
import json
from pathlib import Path
from datetime import datetime, timedelta
import time

OUTPUT_DIR = Path("./network_graphs")
OUTPUT_DIR.mkdir(exist_ok=True)

API_BASE = "http://api.irishrail.ie/realtime/realtime.asmx"

def get_all_trains_today():
    """Get all trains operating today."""
    print("Fetching all trains for today...")
    url = f"{API_BASE}/getAllTrainsXML"
    
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            root = ET.fromstring(response.text)
            trains = []
            
            for train_elem in root.findall('{http://api.irishrail.ie/realtime/}objTrain'):
                train_code = train_elem.findtext('{http://api.irishrail.ie/realtime/}TrainCode', '').strip()
                train_date = train_elem.findtext('{http://api.irishrail.ie/realtime/}TrainDate', '')
                status = train_elem.findtext('{http://api.irishrail.ie/realtime/}TrainStatus', '')
                
                if train_code and train_date:
                    trains.append({
                        'code': train_code,
                        'date': train_date,
                        'status': status
                    })
            
            return trains
    except Exception as e:
        print(f"Error: {e}")
    
    return []

def get_train_journey(train_code, train_date):
    """Get detailed journey info for a specific train."""
    url = f"{API_BASE}/getTrainMovementsXML?TrainId={train_code}&TrainDate={train_date}"
    
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            root = ET.fromstring(response.text)
            
            stops = []
            origin = None
            destination = None
            
            for movement in root.findall('{http://api.irishrail.ie/realtime/}objTrainMovements'):
                location = movement.findtext('{http://api.irishrail.ie/realtime/}LocationFullName')
                stop = {
                    'location': location,
                    'code': movement.findtext('{http://api.irishrail.ie/realtime/}LocationCode'),
                    'order': int(movement.findtext('{http://api.irishrail.ie/realtime/}LocationOrder', 0) or 0),
                    'type': movement.findtext('{http://api.irishrail.ie/realtime/}LocationType'),
                    'scheduled_arrival': movement.findtext('{http://api.irishrail.ie/realtime/}ScheduledArrival'),
                    'scheduled_departure': movement.findtext('{http://api.irishrail.ie/realtime/}ScheduledDeparture'),
                }
                
                if stop['type'] == 'O':
                    origin = location
                elif stop['type'] == 'D':
                    destination = location
                
                if location:  # Skip entries with no location
                    stops.append(stop)
            
            if stops:
                return {
                    'train_code': train_code,
                    'train_date': train_date,
                    'origin': origin or (stops[0]['location'] if stops else None),
                    'destination': destination or (stops[-1]['location'] if stops else None),
                    'total_stops': len(stops),
                    'stops': stops
                }
    
    except Exception as e:
        print(f"  Error fetching {train_code}: {e}")
    
    return None

def main():
    print("=" * 60)
    print("FETCHING IRISH RAIL TRAIN JOURNEYS")
    print("=" * 60)
    
    # Get today's date in format needed by API
    today = datetime.now().strftime("%d/%m/%Y")
    
    print(f"\nFetching trains for: {today}")
    trains = get_all_trains_today()
    print(f"Found {len(trains)} trains today\n")
    
    journeys = []
    successful = 0
    
    # Fetch first 20 trains as sample (to avoid too many API calls)
    for i, train in enumerate(trains[:20], 1):
        train_code = train['code']
        print(f"[{i:2}/{min(20, len(trains))}] Fetching journey for train {train_code}...", end=" ")
        
        journey = get_train_journey(train_code, today)
        if journey:
            journeys.append(journey)
            successful += 1
            print(f"✓ {journey['origin']} → {journey['destination']} ({journey['total_stops']} stops)")
        else:
            print("✗ Failed")
        
        time.sleep(0.5)  # Be nice to the API
    
    print(f"\n✓ Successfully fetched {successful} journeys")
    
    # Save to JSON
    output_file = OUTPUT_DIR / "train_journeys_sample.json"
    with open(output_file, 'w') as f:
        json.dump(journeys, f, indent=2)
    
    print(f"✓ Saved to {output_file}")
    
    # Print summary
    print(f"\n=== SUMMARY ===")
    print(f"Total journeys: {len(journeys)}")
    print(f"Total unique stations in journeys: {len(set(stop['location'] for j in journeys for stop in j['stops'] if stop['location']))}")
    
    if journeys:
        print(f"\nSample journey:")
        j = journeys[0]
        print(f"  Train: {j['train_code']}")
        print(f"  Route: {j['origin']} → {j['destination']}")
        print(f"  Stops: {j['total_stops']}")
        print(f"  Duration: {j['stops'][0]['scheduled_departure']} to {j['stops'][-1]['scheduled_arrival']}")

if __name__ == "__main__":
    main()
