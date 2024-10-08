use schemars::{
    gen::{SchemaGenerator, SchemaSettings},
    schema::RootSchema,
    JsonSchema,
};
use serde::{Deserialize, Serialize};

use crate::{deprecated::Deprecated, method::Method};

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
    SSE(RootSchema),
}

impl Kind {
    pub fn is_some(&self) -> bool {
        matches!(self, Kind::Any | Kind::Schema(_) | Kind::Websocket { .. })
    }

    pub fn is_websocket(&self) -> bool { matches!(self, Kind::Websocket { .. }) }

    pub fn is_sse(&self) -> bool { matches!(self, Kind::SSE(_)) }

    // fn is_none(&self) -> bool { matches!(self, Kind::None) }
}

pub trait Tag {
    fn tag_name(&self) -> &'static str;
}

impl Tag for &'static str {
    fn tag_name(&self) -> &'static str { self }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestInfo {
    pub path: String,
    pub method: Method,
    pub tag: String,
    pub req: Kind,
    pub res: Kind,
    pub deprecated: Deprecated,
    pub is_params: bool,
    #[serde(default)]
    pub error_codes: Vec<(u16, String)>,
}

pub fn settings() -> SchemaSettings {
    let mut settings = SchemaSettings::default();
    settings.inline_subschemas = true;
    settings.meta_schema =
        Some("http://json-schema.org/draft-03/hyper-schema".to_string());
    settings
}

pub fn generator(settings: SchemaSettings) -> SchemaGenerator {
    SchemaGenerator::new(settings)
}

impl RequestInfo {
    pub fn new(path: &'static str, method: Method, tag: impl Tag) -> RequestInfo {
        RequestInfo {
            is_params: matches!(method, Method::Get | Method::Head | Method::Delete),
            path: path.to_string(),
            method,
            tag: tag.tag_name().to_string(),
            req: Kind::None,
            res: Kind::None,
            deprecated: Deprecated::default(),
            error_codes: Vec::new(),
        }
    }

    pub fn with_error(mut self, code: u16, desc: &'static str) -> Self {
        self.error_codes.push((code, desc.to_string()));
        self
    }

    pub fn with_req_schema<T: JsonSchema>(mut self) -> Self {
        if self.req.is_some() {
            panic!("RequestInfo already has a request schema");
        }

        // query params are not nullable
        let gen = if matches!(self.method, Method::Get | Method::Head | Method::Delete) {
            let mut settings = settings();
            settings.option_add_null_type = false;
            generator(settings)
        } else {
            generator(settings())
        };

        let mut res = gen.into_root_schema_for::<T>();
        res.schema.metadata = None;
        self.req = Kind::Schema(res);
        self
    }

    pub fn with_res_schema<T: JsonSchema>(mut self) -> Self {
        if self.res.is_some() {
            panic!("RequestInfo already has a response schema");
        }

        let mut res = generator(settings()).into_root_schema_for::<T>();
        res.schema.metadata = None;
        self.res = Kind::Schema(res);
        self
    }

    pub fn with_sse<Message: JsonSchema>(mut self) -> Self {
        if self.res.is_some() {
            panic!("RequestInfo already has a response schema");
        }
        if self.method != Method::Get {
            panic!("RequestInfo with websockets can only be GET requests");
        }

        let mut res = generator(settings()).into_root_schema_for::<Message>();
        res.schema.metadata = None;
        self.res = Kind::SSE(res);
        self
    }

    pub fn with_websocket<Client: JsonSchema, Server: JsonSchema>(mut self) -> Self {
        if self.res.is_some() {
            panic!("RequestInfo already has a response schema");
        }
        if self.method != Method::Get {
            panic!("RequestInfo with websockets can only be GET requests");
        }

        let mut client_msg = generator(settings()).into_root_schema_for::<Client>();
        client_msg.schema.metadata = None;
        let mut server_msg = generator(settings()).into_root_schema_for::<Server>();
        server_msg.schema.metadata = None;

        self.res = Kind::Websocket {
            server_msg,
            client_msg,
        };
        self
    }

    pub fn with_deprecation_note(mut self, new_route: &RequestInfo) -> Self {
        if self.deprecated.is() {
            panic!("RequestInfo already has a response schema");
        }

        self.deprecated = Deprecated::WithInfo(
            new_route.path.clone(),
            new_route.method,
            new_route.tag.clone(),
        );
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
