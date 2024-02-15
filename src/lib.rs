mod gen;
mod method;
mod types;

pub use std::error::Error as StdError;

pub use gen::generate;
pub use types::{generator, Kind, RequestInfo, Requests, Tag};
