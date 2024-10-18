use std::{
    fmt::{Display, Formatter},
    mem,
};

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
    pub fn is_none(&self) -> bool { matches!(self, Kind::None) }

    pub fn is_some(&self) -> bool {
        matches!(self, Kind::Any | Kind::Schema(_) | Kind::Websocket { .. })
    }

    pub fn is_schema(&self) -> bool { matches!(self, Kind::Schema(_)) }

    pub fn is_websocket(&self) -> bool { matches!(self, Kind::Websocket { .. }) }

    pub fn is_sse(&self) -> bool { matches!(self, Kind::SSE(_)) }

    fn replace(&mut self, new: Kind) -> Kind { mem::replace(self, new) }

    // fn is_none(&self) -> bool { matches!(self, Kind::None) }
}

impl Display for Kind {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", match self {
            Kind::None => "none",
            Kind::Any => "any",
            Kind::Schema(_) => "defined",
            Kind::Websocket { .. } => "websocket",
            Kind::SSE(_) => "server side events",
        })
    }
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
    pub req_body: Kind,
    pub req_params: Kind,
    pub res_body: Kind,
    pub deprecated: Deprecated,
    #[serde(default)]
    pub error_codes: Vec<(u16, String)>,
}

pub fn settings(option_add_null_type: bool) -> SchemaSettings {
    let mut settings = SchemaSettings::default();
    settings.inline_subschemas = true;
    settings.option_add_null_type = option_add_null_type;
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
            path: path.to_string(),
            method,
            tag: tag.tag_name().to_string(),
            req_body: Kind::None,
            req_params: Kind::None,
            res_body: Kind::None,
            deprecated: Deprecated::default(),
            error_codes: Vec::new(),
        }
    }

    pub fn with_error(mut self, code: u16, desc: &'static str) -> Self {
        self.error_codes.push((code, desc.to_string()));
        self
    }

    pub fn with_req_params<T: JsonSchema>(mut self) -> Self {
        let gen = generator(settings(false));

        let mut res = gen.into_root_schema_for::<T>();
        res.schema.metadata = None;

        assert!(
            self.req_params.replace(Kind::Schema(res)).is_none(),
            "Request params schema already present"
        );

        self
    }

    pub fn with_req_body<T: JsonSchema>(mut self) -> Self {
        let gen = generator(settings(true));

        let mut res = gen.into_root_schema_for::<T>();
        res.schema.metadata = None;

        assert!(
            self.req_body.replace(Kind::Schema(res)).is_none(),
            "Request body schema already present"
        );

        self
    }

    pub fn with_req_schema<T: JsonSchema>(self) -> Self {
        if self.request_default_params() {
            self.with_req_params::<T>()
        } else {
            self.with_req_body::<T>()
        }
    }

    pub fn with_res_schema<T: JsonSchema>(mut self) -> Self {
        let mut res = generator(settings(true)).into_root_schema_for::<T>();
        res.schema.metadata = None;

        assert!(
            self.res_body.replace(Kind::Schema(res)).is_none(),
            "Response schema already present"
        );

        self
    }

    pub fn with_any_req_body(mut self) -> Self {
        assert!(
            self.req_body.replace(Kind::Any).is_none(),
            "Response schema already present"
        );

        self
    }

    pub fn with_any_req_params(mut self) -> Self {
        assert!(
            self.req_params.replace(Kind::Any).is_none(),
            "Response schema already present"
        );

        self
    }

    pub fn with_any_req(self) -> Self {
        if self.request_default_params() {
            self.with_any_req_params()
        } else {
            self.with_any_req_body()
        }
    }

    pub fn with_any_res(mut self) -> Self {
        assert!(
            self.res_body.replace(Kind::Any).is_none(),
            "Response schema already present"
        );

        self
    }


    pub fn with_sse<Message: JsonSchema>(mut self) -> Self {
        if self.method != Method::Get {
            panic!("RequestInfo with websockets can only be GET requests");
        }

        let mut res = generator(settings(true)).into_root_schema_for::<Message>();
        res.schema.metadata = None;

        assert!(
            self.res_body.replace(Kind::SSE(res)).is_none(),
            "Response schema already present"
        );

        self
    }

    pub fn with_websocket<Client: JsonSchema, Server: JsonSchema>(mut self) -> Self {
        if self.method != Method::Get {
            panic!("RequestInfo with websockets can only be GET requests");
        }

        let mut client_msg = generator(settings(true)).into_root_schema_for::<Client>();
        client_msg.schema.metadata = None;
        let mut server_msg = generator(settings(true)).into_root_schema_for::<Server>();
        server_msg.schema.metadata = None;

        assert!(
            self.res_body
                .replace(Kind::Websocket {
                    server_msg,
                    client_msg,
                })
                .is_none(),
            "Response schema already present"
        );

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

    fn request_default_params(&self) -> bool {
        matches!(self.method, Method::Get | Method::Head | Method::Delete)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requests {
    pub requests: Vec<RequestInfo>,
}

impl Requests {
    pub fn with(mut self, info_fn: impl FnOnce() -> RequestInfo) -> Self {
        self.requests.push(info_fn());
        self
    }

    // pub fn with_raw(mut self, info: RequestInfo) -> Self {
    //     self.requests.push(info);
    //     self
    // }
}
