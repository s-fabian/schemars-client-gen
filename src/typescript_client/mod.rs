use std::{collections::BTreeMap, error::Error as StdError};

use keywords::KEYWORDS;
use schemars_to_zod::pretty::default_pretty_conf;

use crate::types::{RequestInfo, Requests};

mod function;
mod keywords;
mod misc;
mod types;

pub(crate) fn first_upper(s: impl AsRef<str>) -> String {
    let mut s: Vec<char> = s.as_ref().chars().collect();
    s[0] = s[0].to_uppercase().next().unwrap();
    s.into_iter().collect()
}

fn make_name(info: &RequestInfo) -> String {
    make_name_raw(info.method.to_string(), info.path.clone(), info.tag.clone())
}

fn make_name_raw(method: String, path: String, tag: String) -> String {
    let start = method.to_string().to_lowercase();

    let path = path.strip_prefix('/').unwrap_or(&path);
    let path = path.strip_prefix("api/").unwrap_or(path);
    let path = path.strip_prefix(&format!("{}/", tag)).unwrap_or(path);

    let path = path
        .split(&['-', '/', '_'][..])
        .map(str::to_lowercase)
        .map(first_upper)
        .collect::<Vec<String>>()
        .join("");
    format!("{start}{path}")
}

fn format_js(js: &str) -> Result<String, Box<dyn StdError>> {
    let mut config = default_pretty_conf();
    config.line_width = 90;
    config.indent_width = 4;

    schemars_to_zod::pretty::format_js(js, "client.ts", &config)
}

fn namespace_name(tag: &str) -> String {
    if KEYWORDS.contains(&tag) {
        let tag = format!(
            "n{}{}",
            tag.chars().next().unwrap().to_uppercase(),
            tag.chars().skip(1).collect::<String>()
        );

        tag
    } else {
        String::from(tag)
    }
}

pub(crate) const TAB: &str = "    ";

pub fn generate(Requests { requests }: Requests) -> Result<String, Box<dyn StdError>> {
    let requests: Vec<RequestInfo> =
        requests.into_iter().filter(|r| r.add_to_client).collect();

    let mut namespaces = BTreeMap::<&'static str, Vec<String>>::new();
    let mut classes = String::from(include_str!("base/client.ts"));
    let imports = format!("{}\n", schemars_to_zod::ZOD_IMPORT);

    let ws = include_str!("base/websocket.ts");
    let sse = include_str!("base/sse.ts");

    if requests.iter().any(|r| r.res_body.is_websocket()) {
        classes.push_str(ws);
    }

    if requests.iter().any(|r| r.res_body.is_sse()) {
        // imports.push_str(
        //     "import { EventSourcePolyfill, type EventSourcePolyfillInit } from \
        //      'event-source-polyfill';\n",
        // );
        classes.push_str(sse);
    }

    let mut out = format!(
        r#"{imports}
export namespace client {{

{classes}
"#
    );

    for v in &requests {
        let mut s = String::new();
        let name = make_name(v);

        v.append_req_params_type(&name, &mut s)?;
        v.append_req_body_type(&name, &mut s)?;
        v.append_res_body_type(&name, &mut s)?;
        v.append_function(&name, &mut s)?;

        namespaces.entry(&v.tag).or_default().push(s);
    }

    out.push_str(
        &namespaces
            .iter()
            .map(|(tag, res)| {
                let tag = namespace_name(tag);
                let mut s = format!("export namespace {tag} {{\n");

                s.push_str(&res.join("\n"));
                s.push_str("\n}");
                s
            })
            .collect::<Vec<String>>()
            .join("\n\n"),
    );

    out.push('}');

    format_js(&out)
}
