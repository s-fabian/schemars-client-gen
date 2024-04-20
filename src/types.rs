use std::any::Any;

use schemars::{
    gen::{SchemaGenerator, SchemaSettings},
    schema::RootSchema,
    JsonSchema,
};
use serde::{Deserialize, Serialize, Serializer};

use crate::method::Method;

#[derive(Debug, Clone, Default, JsonSchema, Serialize, Deserialize)]
pub enum Kind {
    #[default]
    None,
    Any,
    Schema(RootSchema),
    Websocket {
        client_msg: RootSchema,
        server_msg: RootSchema,
    },
}

impl Kind {
    pub fn is_some(&self) -> bool {
        matches!(self, Kind::Any | Kind::Schema(_) | Kind::Websocket { .. })
    }

    pub fn is_websocket(&self) -> bool { matches!(self, Kind::Websocket { .. }) }

    // fn is_none(&self) -> bool { matches!(self, Kind::None) }
}

pub trait Tag {
    fn tag_name(&self) -> &'static str;
}

impl Tag for &'static str {
    fn tag_name(&self) -> &'static str {
        self
    }
}

fn to_string<S>(x: impl ToString, s: S) -> Result<S::Ok, S::Error>
where S: Serializer {
    s.serialize_str(&x.to_string())
}

fn option_some<S>(x: &Option<impl Any>, s: S) -> Result<S::Ok, S::Error>
where S: Serializer {
    s.serialize_bool(x.is_some())
}

#[derive(Debug, Clone, Serialize)]
pub struct RequestInfo {
    pub path: &'static str,
    #[serde(serialize_with = "to_string")]
    pub method: Method,
    pub tag: &'static str,
    pub req: Kind,
    pub res: Kind,
    #[serde(serialize_with = "option_some")]
    pub deprecated: Option<(&'static str, Method, &'static str)>,
    pub is_params: bool,
    pub error_codes: Vec<(u16, &'static str)>,
}

pub fn generator() -> SchemaGenerator {
    let mut settings = SchemaSettings::default();
    settings.inline_subschemas = true;
    settings.meta_schema =
        Some("http://json-schema.org/draft-03/hyper-schema".to_string());
    SchemaGenerator::new(settings)
}

impl RequestInfo {
    pub fn new(path: &'static str, method: Method, tag: impl Tag) -> RequestInfo {
        RequestInfo {
            is_params: matches!(method, Method::Get | Method::Head | Method::Delete),
            path,
            method,
            tag: tag.tag_name(),
            req: Kind::None,
            res: Kind::None,
            deprecated: None,
            error_codes: Vec::new(),
        }
    }

    pub fn with_error(mut self, code: u16, desc: &'static str) -> Self {
        self.error_codes.push((code, desc));
        self
    }

    pub fn with_req_schema<T: JsonSchema>(mut self) -> Self {
        if self.req.is_some() {
            panic!("RequestInfo already has a request schema");
        }

        let mut res = generator().into_root_schema_for::<T>();
        res.schema.metadata = None;
        self.req = Kind::Schema(res);
        self
    }

    pub fn with_res_schema<T: JsonSchema>(mut self) -> Self {
        if self.res.is_some() {
            panic!("RequestInfo already has a response schema");
        }

        let mut res = generator().into_root_schema_for::<T>();
        res.schema.metadata = None;
        self.res = Kind::Schema(res);
        self
    }

    pub fn with_websocket<Client: JsonSchema, Server: JsonSchema>(mut self) -> Self {
        if self.res.is_some() {
            panic!("RequestInfo already has a response schema");
        }
        if self.method != Method::Get {
            panic!("RequestInfo with websockets can only be GET requests");
        }

        let mut client_msg = generator().into_root_schema_for::<Client>();
        client_msg.schema.metadata = None;
        let mut server_msg = generator().into_root_schema_for::<Server>();
        server_msg.schema.metadata = None;

        self.res = Kind::Websocket {
            server_msg,
            client_msg,
        };
        self
    }

    pub fn with_deprecation_note(mut self, new_route: &RequestInfo) -> Self {
        if self.deprecated.is_some() {
            panic!("RequestInfo already has a response schema");
        }

        self.deprecated = Some((new_route.path, new_route.method.clone(), new_route.tag));
        self
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Requests {
    pub requests: Vec<RequestInfo>,
}

impl Requests {
    pub fn with(mut self, info_fn: impl Fn() -> RequestInfo) -> Self {
        self.requests.push(info_fn());
        self
    }
    // pub fn with_raw(mut self, info: RequestInfo) -> Self {
    //     self.requests.push(info);
    //     self
    // }
}
