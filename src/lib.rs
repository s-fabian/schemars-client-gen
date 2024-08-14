mod deprecated;
#[cfg(feature = "client-gen")]
mod gen;
mod method;
mod types;

pub use deprecated::Deprecated;
#[cfg(feature = "client-gen")]
pub use gen::generate;
pub use method::{Method, MethodUnknown};
pub use types::{generator, Kind, RequestInfo, Requests, Tag};

#[cfg(test)]
mod tests {
    use schemars::JsonSchema;

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