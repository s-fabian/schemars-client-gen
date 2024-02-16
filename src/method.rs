use std::{
    fmt::{Display, Formatter},
    str::FromStr,
};

use serde::{Deserialize, Serialize};

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
mod actix {
    use actix_web::http::Method as ActixMethod;

    use super::{Method, MethodUnknown};

    impl TryFrom<ActixMethod> for Method {
        type Error = MethodUnknown;

        fn try_from(value: ActixMethod) -> Result<Self, Self::Error> {
            if value == ActixMethod::OPTIONS {
                Ok(Self::Options)
            } else if value == ActixMethod::GET {
                Ok(Self::Get)
            } else if value == ActixMethod::POST {
                Ok(Self::Post)
            } else if value == ActixMethod::PUT {
                Ok(Self::Put)
            } else if value == ActixMethod::DELETE {
                Ok(Self::Delete)
            } else if value == ActixMethod::HEAD {
                Ok(Self::Head)
            } else if value == ActixMethod::TRACE {
                Ok(Self::Trace)
            } else if value == ActixMethod::CONNECT {
                Ok(Self::Connect)
            } else if value == ActixMethod::PATCH {
                Ok(Self::Patch)
            } else {
                Err(MethodUnknown)
            }
        }
    }
}
