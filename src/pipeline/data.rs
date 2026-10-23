//! `missions.data` (pipeline.md **Mission data**): the pipeline's stage results as one JSON
//! object, one key per owner. Read whole, changed, written whole with the next `record` or
//! outcome (`Data::text`).

use serde_json::{Map, Value};

use crate::mission::Mission;

/// A mission's `data`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Data(pub Map<String, Value>);

impl Data {
    /// `m.data` (not an object, or unreadable: empty).
    pub fn of(m: &Mission) -> Data {
        Data::parse(&m.data)
    }

    pub fn parse(text: &str) -> Data {
        match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(o)) => Data(o),
            _ => Data::default(),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key).filter(|v| !v.is_null())
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    pub fn u64(&self, key: &str) -> Option<u64> {
        self.get(key).and_then(Value::as_u64)
    }

    pub fn bool(&self, key: &str) -> bool {
        self.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    /// Sets `key` (`Value::Null` removes it).
    pub fn set(&mut self, key: &str, v: impl Into<Value>) {
        match v.into() {
            Value::Null => {
                self.0.remove(key);
            }
            v => {
                self.0.insert(key.to_string(), v);
            }
        }
    }

    /// The JSON text for `missions.data`.
    pub fn text(&self) -> String {
        Value::Object(self.0.clone()).to_string()
    }

    /// The last run or log number of `family` (`n.<family>`; none yet: 0).
    pub fn n(&self, family: &str) -> u32 {
        self.get("n")
            .and_then(|n| n.get(family))
            .and_then(Value::as_u64)
            .map_or(0, |n| n as u32)
    }

    /// The next number of `family`, stored as its last (record it with the step that uses it:
    /// a re-entry reads it back with [`Data::n`]).
    pub fn next_n(&mut self, family: &str) -> u32 {
        let n = self.n(family) + 1;
        let mut all = match self.0.remove("n") {
            Some(Value::Object(o)) => o,
            _ => Map::new(),
        };
        all.insert(family.to_string(), Value::from(n));
        self.0.insert("n".into(), Value::Object(all));
        n
    }
}
