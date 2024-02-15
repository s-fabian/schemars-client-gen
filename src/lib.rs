#[cfg(feature = "client-gen")]
mod gen;
mod method;
mod types;

pub use std::error::Error as StdError;

#[cfg(feature = "client-gen")]
pub use gen::generate;
pub use types::{generator, Kind, RequestInfo, Requests, Tag};
