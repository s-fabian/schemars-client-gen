use serde::{Deserialize, Serialize};

use crate::Method;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Deprecated {
    Simple(bool),
    WithInfo(String, Method, String),
}

impl Deprecated {
    pub fn is(&self) -> bool {
        matches!(
            self,
            Deprecated::Simple(true) | Deprecated::WithInfo(_, _, _)
        )
    }
}

impl Default for Deprecated {
    fn default() -> Self { Self::Simple(false) }
}
