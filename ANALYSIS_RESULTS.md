# Irish Rail Data Analysis Results

## Overview
Real-time analysis of Irish Rail network data, based on continuous collection of train positions, station events, and journey data.

---

## 📊 Key Findings

### 1. **STATION TRAFFIC** (Busiest Stations)
The Dublin commuter network dominates by far:

| Station | Events | Unique Trains |
|---------|--------|---------------|
| Dublin Connolly | 28,566 | 89 |
| Dublin Pearse | 21,204 | 67 |
| Tara Street | 21,188 | 66 |
| Grand Canal Dock | 20,214 | 65 |
| Hazelhatch | 19,944 | 22 |

**Insight:** The 4 central Dublin stations account for ~91k events (13% of all traffic). The network is heavily Dublin-centric for commuter patterns.

---

### 2. **TRAIN DELAYS ANALYSIS**
Average delays vary significantly by station:

| Station | Avg Delay | Max Delay |
|---------|-----------|-----------|
| Sligo | 5 min | 10 min |
| Rosslare Strand | 5 min | 6 min |
| Collooney | 5 min | 10 min |
| Galway | 3 min | 73 min ⚠️ |
| Longford | 3 min | 15 min |

**Key Insights:**
- **Galway route** has the worst outlier (73 min delay) - suggests service disruptions
- **Western stations** (Sligo, Rosslare) average 5 min delays - longest wait times
- **Dublin area** stations < 3 min avg (well-optimized commuter service)
- Overall: **Average train is ~1-2 minutes late**

---

### 3. **ROUTE PATTERNS** (Most Common Connections)
The commuter belt dominates:

| Route | Events | Trains |
|-------|--------|--------|
| Bray ↔ Howth | 65,697 | 8 |
| Malahide ↔ Bray | 62,672 | 9 |
| Howth → Greystones | 47,676 | 6 |
| Bray ↔ Malahide | 43,832 | 9 |
| Dublin Heuston ↔ Portlaoise | 28,361 | 7 |

**Insight:** South/North Dublin commuter lines (DART) see massive traffic. These few routes account for ~250k events (35% of all movement).

---

### 4. **TRAIN TYPES**
Only 2 train types in the system:

| Type | Events | Avg Delay | Trains |
|------|--------|-----------|--------|
| Train | 444,794 | 1 min | 185 |
| DART | 341,535 | 1 min | 54 |

**Insight:**
- **DART (Dublin commuter)** = 43% of network traffic despite only 29% of trains
- Both maintain excellent 1-minute punctuality on average
- 185 unique train codes tracked (comprehensive coverage)

---

### 5. **DIRECTIONAL FLOW**
Strong North-South commuter patterns:

| Direction | Events | Trains | Stations |
|-----------|--------|--------|----------|
| Southbound | 282,443 | 64 | 93 |
| Northbound | 259,784 | 60 | 86 |
| To Dublin Heuston | 50,923 | 17 | 49 |
| To Cork | 31,690 | 19 | 23 |
| To Portlaoise | 28,564 | 7 | 21 |

**Insight:** Bidirectional commuter service is balanced (52%/48% split). Long-distance routes (Cork, Portlaoise) are secondary to commuter traffic.

---

### 6. **TRAIN STATUS**
Most trains have minimal status updates:

| Status | Count |
|--------|-------|
| No Information | 445,121 (57%) |
| En Route | 338,853 (43%) |

**Insight:** Trains run smoothly with minimal disruptions reported. No "Delayed" or "Cancelled" status commonly seen.

---

## 🚀 What Makes This Data Valuable?

1. **Demand Forecasting** - Heavy concentration on Dublin routes shows where capacity is needed
2. **Punctuality Benchmarking** - Average 1-2 min delays is excellent; Galway outlier needs investigation
3. **Route Optimization** - Bray-Howth route alone = 65k events; bottleneck analysis possible
4. **Infrastructure Planning** - Hazelhatch (19.9k events) vs other stations shows growth areas
5. **Real-time Operations** - Continuous monitoring enables live delay prediction

---

## 📈 Data Volume
- **Total Events**: 784,000+
- **Stations Tracked**: 171
- **Unique Trains**: 239+
- **Time Series**: Continuous collection since startup
- **Granularity**: 30-second snapshots for trains, event-based for stations

---

## 🔍 Next Analysis Ideas
- Temporal patterns (peak hours, day-of-week variations)
- Correlation between delays and specific train types
- Route complexity vs punctuality
- Station-to-station journey time accuracy
- Predictive modeling for delays
