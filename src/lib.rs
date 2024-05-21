mod deprecated;
#[cfg(feature = "client-gen")]
mod gen;
mod method;
mod types;

pub(crate) use std::error::Error as StdError;

pub use deprecated::Deprecated;
#[cfg(feature = "client-gen")]
pub use gen::generate;
pub use method::{Method, MethodUnknown};
pub use types::{generator, Kind, RequestInfo, Requests, Tag};
