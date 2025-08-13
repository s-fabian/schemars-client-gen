mod deprecated;
mod keywords;
mod method;
mod types;
#[cfg(feature = "client-gen")]
mod typescript_client;

pub use deprecated::Deprecated;
pub use method::{Method, MethodUnknown};
pub use types::{generator, Kind, RequestInfo, Requests, Tag};
#[cfg(feature = "client-gen")]
pub use typescript_client::generate;

#[cfg(test)]
mod tests {
    use schemars::JsonSchema;

    use crate::{generate, Method, RequestInfo, Requests};

    #[derive(JsonSchema)]
    struct Req {
        name: String,
        age: u8,
    }

    #[derive(JsonSchema)]
    struct Msg {
        info: String,
        data: Vec<u8>,
    }

    #[test]
    fn main() {
        let info = RequestInfo::new("/api/sse", Method::Get, "main")
            .with_req_schema::<Req>()
            .with_sse::<Msg>();

        let out = generate(Requests {
            requests: vec![info],
        })
        .unwrap();

        std::fs::write("sse.ts", out).unwrap();
    }
}
