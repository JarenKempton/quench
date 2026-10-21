use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Distribution {
    pub n: usize,
    pub p10: u64,
    pub p50: u64,
    pub p90: u64,
}

impl Distribution {
    pub fn of(mut values: Vec<u64>) -> Self {
        if values.is_empty() {
            return Distribution::default();
        }
        values.sort_unstable();
        let at = |q: f64| values[((values.len() - 1) as f64 * q).round() as usize];
        Distribution {
            n: values.len(),
            p10: at(0.1),
            p50: at(0.5),
            p90: at(0.9),
        }
    }
}
