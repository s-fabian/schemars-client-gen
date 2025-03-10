use std::{collections::BTreeMap, error::Error as StdError};

use schemars_to_zod::{pretty::default_pretty_conf, Config, Parser};

use crate::{
    keywords::KEYWORDS,
    types::{Kind, RequestInfo, Requests},
    Deprecated,
};

fn first_upper(s: impl AsRef<str>) -> String {
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

pub fn generate(Requests { requests }: Requests) -> Result<String, Box<dyn StdError>> {
    let requests: Vec<RequestInfo> =
        requests.into_iter().filter(|r| r.add_to_client).collect();

    let mut namespaces = BTreeMap::<&'static str, Vec<String>>::new();
    let mut classes = String::from(include_str!("base/client.ts"));

    let ws = include_str!("base/websocket.ts");
    let sse = include_str!("base/sse.ts");

    if requests.iter().any(|r| r.res_body.is_websocket()) {
        classes.push_str(ws);
    }

    if requests.iter().any(|r| r.res_body.is_sse()) {
        classes.push_str(sse);
    }

    let mut out = format!(
        r#"import {{ z }} from 'zod';

export namespace client {{

{classes}
"#
    );

    let config = Config {
        use_coerce_date: Default::default(),
        array_wrapper: false,
        explicit_min_max: false,
        add_descriptions: true,
        union_first: true,
        add_default: false,
        ignore_undefined: false,
    };

    let i_parser = Parser::new(Config {
        use_coerce_date: false,
        ..config
    });
    let o_parser = Parser::new(Config {
        use_coerce_date: true,
        #[cfg(feature = "add-undefined")]
        ignore_undefined: false,
        #[cfg(not(feature = "add-undefined"))]
        ignore_undefined: true,
        ..config
    });

    for v in &requests {
        let mut s = String::new();
        let name = make_name(v);
        let struct_name = first_upper(&name);

        match &v.req_params {
            Kind::None => {},

            Kind::Any => {
                s.push_str(&format!(
                    "    export type {struct_name}Params = Record<string, string>;\n\n"
                ));
            },

            Kind::Schema(schema) => {
                let zod =
                    i_parser
                        .parse_schema_object(&schema.schema)
                        .inspect_err(|_| {
                            #[cfg(feature = "binary")]
                            eprintln!("Error in client schema generation of: {name}")
                        })?;

                s.push_str(&format!("    const {name}ParamsSchema = {};\n", zod));
                s.push_str(&format!(
                    "    export type {struct_name}Params = z.input<typeof \
                     {name}ParamsSchema>;\n\n"
                ));
            },

            kind => panic!("Unexpected kind: {kind}"),
        }

        match &v.req_body {
            Kind::None => {},

            Kind::Any => {
                s.push_str(&format!(
                    "    type {struct_name}Req = Blob | FormData | string;\n\n"
                ));
            },

            Kind::Schema(schema) => {
                let zod =
                    i_parser
                        .parse_schema_object(&schema.schema)
                        .inspect_err(|_| {
                            #[cfg(feature = "binary")]
                            eprintln!("Error in client schema generation of: {name}")
                        })?;
                s.push_str(&format!("    const {name}ReqSchema = {};\n", zod));
                s.push_str(&format!(
                    "    export type {struct_name}Req = z.input<typeof \
                     {name}ReqSchema>;\n\n"
                ));
            },

            kind => panic!("Unexpected kind: {kind}"),
        }

        match &v.res_body {
            Kind::None => {},
            Kind::Any => {
                s.push_str(&format!("    export type {struct_name}Res = unknown;\n\n"));
            },
            Kind::Schema(schema) => {
                let zod =
                    o_parser
                        .parse_schema_object(&schema.schema)
                        .inspect_err(|_| {
                            #[cfg(feature = "binary")]
                            eprintln!("Error in server schema generation of: {name}")
                        })?;

                s.push_str(&format!("    const {name}ResSchema = {};\n", zod));
                s.push_str(&format!(
                    "    export type {struct_name}Res = z.output<typeof \
                     {name}ResSchema>;\n\n"
                ));
            },
            Kind::Websocket {
                client_msg,
                server_msg,
            } => {
                let client_msg = i_parser
                    .parse_schema_object(&client_msg.schema)
                    .inspect_err(|_| {
                        #[cfg(feature = "binary")]
                        eprintln!(
                            "Error in websocket client schema generation of: {name}"
                        )
                    })?;
                let server_msg = o_parser
                    .parse_schema_object(&server_msg.schema)
                    .inspect_err(|_| {
                        #[cfg(feature = "binary")]
                        eprintln!("Error in websocket server generation of: {name}")
                    })?;

                s.push_str(&format!(
                    "    const {name}ClientMsgSchema = {};\n",
                    client_msg
                ));
                s.push_str(&format!(
                    "    export type {struct_name}ClientMsg = z.output<typeof \
                     {name}ClientMsgSchema>;\n"
                ));

                s.push_str(&format!(
                    "    const {name}ServerMsgSchema = {};\n",
                    server_msg
                ));
                s.push_str(&format!(
                    "    export type {struct_name}ServerMsg = z.output<typeof \
                     {name}ServerMsgSchema>;\n"
                ));

                s.push_str(&format!(
                    "    export type {struct_name}Websocket = \
                     WebsocketWrapper<{struct_name}ClientMsg, \
                     {struct_name}ServerMsg>;\n\n"
                ));
            },
            Kind::SSE(schema) => {
                let zod =
                    o_parser
                        .parse_schema_object(&schema.schema)
                        .inspect_err(|_| {
                            #[cfg(feature = "binary")]
                            eprintln!("Error in server schema generation of: {name}")
                        })?;

                s.push_str(&format!("    const {name}Msg = {};\n", zod));
                s.push_str(&format!(
                    "    export type {struct_name}Msg = z.output<typeof {name}Msg>;\n\n"
                ));
                s.push_str(&format!(
                    "    export type {struct_name}SSE = SSE<{struct_name}Msg>;\n\n"
                ));
            },
        }

        if let Deprecated::WithInfo(path, method, tag) = &v.deprecated {
            let new =
                make_name_raw(method.to_string(), path.to_string(), tag.to_string());

            s.push_str(&format!(
                "    /** @deprecated Please use {{@link {new}}} instead */\n",
            ));
        } else if matches!(&v.deprecated, &Deprecated::Simple(true)) {
            s.push_str("    /** @deprecated */\n");
        }

        const TABS: &str = "    ";

        let comment = if v.error_codes.is_empty() {
            String::new()
        } else {
            format!(
                "{TABS}/**\n{TABS} * Error responses:\n{TABS} *\n{TABS} * {}\n{TABS} \
                 */\n",
                v.error_codes
                    .iter()
                    .map(|(code, info)| { format!("{code}: {info}") })
                    .collect::<Vec<String>>()
                    .join(&format!("\n{TABS} *\n{TABS} * ")),
            )
        };

        if v.res_body.is_sse() {
            // todo!() make https dynamic
            s.push_str(&format!(
                "{comment}    export function {name}({req_params}): {struct_name}SSE {{
        \
                 const url = (!options.baseUrl || options.baseUrl.startsWith('/'))
            \
                 && 'location' in global
            ? `https://${{(global.location as any).host}}${{options.baseUrl}}`
            : options.baseUrl;

        return new SSE(
            () => new EventSource(
                `${{url}}{path}{params_suffix}`,
                {{ ...options.globalInit, withCredentials: true }}
            ),
            (data) => options.unsafe ? data as {struct_name}Msg : {name}Msg.parse(data),
        )
    }}\n",
                // where to fetch
                path = v.path,
                // make the query string
                params_suffix = if v.req_params.is_some() {
                    format!(
                        "${{makeQuery(options.unsafe ? params as {struct_name}Params : \
                         {name}ParamsSchema.parse(params))}}"
                    )
                } else {
                    String::new()
                },
                // the request query parameter
                req_params = if v.req_params.is_some() {
                    format!("params: {struct_name}Params, ")
                } else {
                    String::new()
                },
            ));
        } else if v.res_body.is_websocket() {
            s.push_str(&format!(
                "{comment}    export function {name}({req_params}): \
                 {struct_name}Websocket {{
        const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://'

        const wsBaseUrl = (!options.baseUrl || options.baseUrl.startsWith('/'))
            ? `${{protocol}}${{location.host}}${{options.baseUrl}}`
            : (protocol + options.baseUrl.replace(/^https:\\/\\//, \
                 '').replace(/^http:\\/\\//, ''))

        return new WebsocketWrapper(
            () => new WebSocket(
                `${{wsBaseUrl}}{path}{params_suffix}`
            ),
            (data) => options.unsafe ? data as {struct_name}ClientMsg : \
                 {name}ClientMsgSchema.parse(data),
            (data) => options.unsafe ? data as {struct_name}ServerMsg : \
                 {name}ServerMsgSchema.parse(data)
        )
    }}\n",
                // the function name
                name = name,
                // the request query parameter
                req_params = if v.req_params.is_some() {
                    format!("params: {struct_name}Params, ")
                } else {
                    String::new()
                },
                // where to fetch
                path = v.path,
                // make the query string
                params_suffix = if v.req_params.is_some() {
                    format!(
                        "${{makeQuery(options.unsafe ? params as {struct_name}Params : \
                         {name}ParamsSchema.parse(params))}}"
                    )
                } else {
                    String::new()
                },
            ));
        } else {
            s.push_str(&format!(
                "{comment}    export function {name}({req_json}{req_params}init: \
                 RequestInit = {{}}): PromiseWrapper<{res_name}> {{
        return new PromiseWrapper(
            options.fetch(
                new Request(
                    options.baseUrl + '{path}'{params_suffix},
                    {{
                        method: '{method}',
                        body: {req},
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,{headers_addition}
                    }}
                )
            ){res}
        )
    }}\n",
                // the function name
                name = name,
                // the request body parameter
                req_json = if v.req_body.is_some() {
                    format!("req: {struct_name}Req, ")
                } else {
                    String::new()
                },
                // the request query parameter
                req_params = if v.req_params.is_some() {
                    format!("params: {struct_name}Params, ")
                } else {
                    String::new()
                },
                // the response type
                res_name = if v.res_body.is_some() {
                    format!("{struct_name}Res")
                } else {
                    "Response".to_string()
                },
                // where to fetch
                path = v.path,
                // make the query string
                params_suffix = if v.req_params.is_some() {
                    format!(
                        " + makeQuery(options.unsafe ? params as {struct_name}Params : \
                         {name}ParamsSchema.parse(params))"
                    )
                } else {
                    String::new()
                },
                // the method for fetching
                method = v.method,
                // make the request body
                req = if v.req_body.is_none() {
                    String::from("null")
                } else {
                    match &v.req_body {
                        Kind::None => "null".to_string(),
                        Kind::Any => "req".to_string(),
                        Kind::Schema(_) =>
                            format!("JSON.stringify({name}ReqSchema.parse(req))"),
                        Kind::Websocket { .. } => unreachable!(),
                        Kind::SSE { .. } => unreachable!(),
                    }
                },
                headers_addition = if v.req_body.is_schema() {
                    "\nheaders: jsonContentTypeHeader(init.headers as RepresentsHeader, \
                     options.globalInit.headers as RepresentsHeader),"
                } else {
                    ""
                },
                // make the response
                res = match &v.res_body {
                    Kind::None => ".then(res => res.ok ? ok(res) : err(res))".to_string(),
                    Kind::Any => ".then(res => res.ok ? res.text().then(ok) : err(res))"
                        .to_string(),
                    Kind::Schema(_) => format!(
                        ".then(res => res.ok ? res.json().then(options.unsafe ? (data) \
                         => (data as {struct_name}Res) : \
                         {name}ResSchema.parse).then(ok) : err(res))"
                    ),
                    Kind::Websocket { .. } => unreachable!(),
                    Kind::SSE { .. } => unreachable!(),
                },
            ));
        }

        namespaces.entry(&v.tag).or_default().push(s);
    }

    out.push_str(
        &namespaces
            .iter()
            .map(|(tag, res)| {
                let mut s = if KEYWORDS.contains(tag) {
                    let tag = format!(
                        "n{}{}",
                        tag.chars().next().unwrap().to_uppercase(),
                        tag.chars().skip(1).collect::<String>()
                    );

                    format!("export namespace {tag} {{\n")
                } else {
                    format!("export namespace {tag} {{\n")
                };

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
