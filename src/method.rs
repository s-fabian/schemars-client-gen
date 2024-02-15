use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};
use std::str::FromStr;

#[derive(Debug, Copy, Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
pub enum Method {
    Options,
    Get,
    Post,
    Put,
    Delete,
    Head,
    Trace,
    Connect,
    Patch,
}

impl Display for Method {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Method {
    pub fn as_str(&self) -> &'static str {
        match self {
            Method::Options => "OPTIONS",
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Delete => "DELETE",
            Method::Head => "HEAD",
            Method::Trace => "TRACE",
            Method::Connect => "CONNECT",
            Method::Patch => "PATCH",
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct MethodUnknown;

impl Display for MethodUnknown {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str("Method unknown")
    }
}

impl FromStr for Method {
    type Err = MethodUnknown;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "OPTIONS" => Ok(Self::Options),
            "GET" => Ok(Self::Get),
            "POST" => Ok(Self::Post),
            "PUT" => Ok(Self::Put),
            "DELETE" => Ok(Self::Delete),
            "HEAD" => Ok(Self::Head),
            "TRACE" => Ok(Self::Trace),
            "CONNECT" => Ok(Self::Connect),
            "PATCH" => Ok(Self::Patch),
            _ => Err(MethodUnknown),
        }
    }
}

#[cfg(feature = "actix-web")]
mod actix {}
