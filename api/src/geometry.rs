//! small helpers for route geometry. points are (latitude, longitude) in
//! degrees. distances use a local equirectangular projection, which is well
//! under a metre out across the span of one bus route in Ireland

const EARTH_RADIUS_M: f64 = 6_371_008.8;

pub type LatLon = (f64, f64);

fn to_metres(origin: LatLon, point: LatLon) -> (f64, f64) {
    let x = (point.1 - origin.1).to_radians() * origin.0.to_radians().cos() * EARTH_RADIUS_M;
    let y = (point.0 - origin.0).to_radians() * EARTH_RADIUS_M;
    (x, y)
}

fn segment_distance(point: (f64, f64), start: (f64, f64), end: (f64, f64)) -> (f64, f64) {
    // returns (distance to the segment, fraction along it)
    let (dx, dy) = (end.0 - start.0, end.1 - start.1);
    let length_sq = dx * dx + dy * dy;
    let t = if length_sq == 0.0 {
        0.0
    } else {
        (((point.0 - start.0) * dx + (point.1 - start.1) * dy) / length_sq).clamp(0.0, 1.0)
    };
    let (px, py) = (start.0 + t * dx, start.1 + t * dy);
    (((point.0 - px).powi(2) + (point.1 - py).powi(2)).sqrt(), t)
}

/// Douglas-Peucker with an explicit stack, so long shapes can't overflow it
pub fn simplify(points: &[LatLon], tolerance_m: f64) -> Vec<LatLon> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let origin = points[0];
    let projected: Vec<(f64, f64)> = points.iter().map(|&p| to_metres(origin, p)).collect();
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0, points.len() - 1)];
    while let Some((first, last)) = stack.pop() {
        let mut furthest = (0.0, first);
        for index in first + 1..last {
            let (distance, _) =
                segment_distance(projected[index], projected[first], projected[last]);
            if distance > furthest.0 {
                furthest = (distance, index);
            }
        }
        if furthest.0 > tolerance_m {
            keep[furthest.1] = true;
            stack.push((first, furthest.1));
            stack.push((furthest.1, last));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter_map(|(&point, kept)| kept.then_some(point))
        .collect()
}

/// Google's encoded polyline format at five decimal places, about a metre
pub fn encode_polyline(points: &[LatLon]) -> String {
    fn push_value(output: &mut String, value: i64) {
        let mut value = if value < 0 { !(value << 1) } else { value << 1 };
        while value >= 0x20 {
            output.push(char::from((((value & 0x1f) | 0x20) + 63) as u8));
            value >>= 5;
        }
        output.push(char::from((value + 63) as u8));
    }

    let mut output = String::with_capacity(points.len() * 6);
    let mut previous = (0_i64, 0_i64);
    for &(latitude, longitude) in points {
        let current = (
            (latitude * 1e5).round() as i64,
            (longitude * 1e5).round() as i64,
        );
        push_value(&mut output, current.0 - previous.0);
        push_value(&mut output, current.1 - previous.1);
        previous = current;
    }
    output
}

/// a route line with cumulative distance, for placing vehicles along it
pub struct RouteLine {
    origin: LatLon,
    projected: Vec<(f64, f64)>,
    cumulative: Vec<f64>,
}

pub struct Projection {
    /// metres from the start of the line
    pub along_m: f64,
    /// metres from the point to the line
    pub offset_m: f64,
}

impl RouteLine {
    pub fn new(points: &[LatLon]) -> Option<Self> {
        if points.len() < 2 {
            return None;
        }
        let origin = points[0];
        let projected: Vec<(f64, f64)> = points.iter().map(|&p| to_metres(origin, p)).collect();
        let mut cumulative = Vec::with_capacity(projected.len());
        let mut total = 0.0;
        cumulative.push(0.0);
        for pair in projected.windows(2) {
            total += ((pair[1].0 - pair[0].0).powi(2) + (pair[1].1 - pair[0].1).powi(2)).sqrt();
            cumulative.push(total);
        }
        Some(Self {
            origin,
            projected,
            cumulative,
        })
    }

    pub fn length_m(&self) -> f64 {
        *self.cumulative.last().unwrap_or(&0.0)
    }

    /// nearest point on the line. a route that doubles back can match the
    /// wrong leg, so callers should only compare vehicles near each other
    pub fn project(&self, point: LatLon) -> Projection {
        let point = to_metres(self.origin, point);
        let mut best = Projection {
            along_m: 0.0,
            offset_m: f64::INFINITY,
        };
        for (index, pair) in self.projected.windows(2).enumerate() {
            let (distance, t) = segment_distance(point, pair[0], pair[1]);
            if distance < best.offset_m {
                let segment = self.cumulative[index + 1] - self.cumulative[index];
                best = Projection {
                    along_m: self.cumulative[index] + t * segment,
                    offset_m: distance,
                };
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_the_reference_polyline() {
        // the worked example from Google's polyline algorithm docs
        let points = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)];
        assert_eq!(encode_polyline(&points), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    }

    #[test]
    fn simplify_drops_points_on_a_straight_road_and_keeps_corners() {
        let straight: Vec<LatLon> = (0..50)
            .map(|i| (53.0 + f64::from(i) * 1e-4, -9.0))
            .collect();
        assert_eq!(simplify(&straight, 5.0), vec![straight[0], straight[49]]);

        let corner = [
            (53.0, -9.0),
            (53.001, -9.0),
            (53.002, -9.0),
            (53.002, -8.998),
        ];
        assert_eq!(
            simplify(&corner, 5.0),
            vec![corner[0], corner[2], corner[3]]
        );
    }

    #[test]
    fn projects_a_point_beside_the_line_to_its_distance_along() {
        // about 111 m per 0.001 degrees of latitude
        let line = RouteLine::new(&[(53.0, -9.0), (53.002, -9.0)]).unwrap();
        let projection = line.project((53.001, -8.9995));
        assert!((projection.along_m - 111.2).abs() < 0.5);
        assert!((projection.offset_m - 33.5).abs() < 0.5);
        assert!((line.length_m() - 222.4).abs() < 0.5);
    }
}
