use std::fmt::Write;

use serde::de::StdError;

use crate::{
    typescript_client::{first_upper, TAB},
    Kind,
    RequestInfo,
};

impl RequestInfo {
    pub(crate) fn append_function(
        &self,
        name: &str,
        buffer: &mut String,
    ) -> Result<(), Box<dyn StdError>> {
        let struct_name = first_upper(name);

        if self.res_body.is_sse() {
            write!(
                buffer,
                "    export function {name}({req_params}init: RequestInit = {{}}): \
                 {struct_name}SSE {{
        return new SSE(
            () => new EventSauce(
                new Request(
                    options.baseUrl + '{path}'{params_suffix},
                    {{
                        method: '{method}',
                        credentials: 'include',
                        ...options.globalInit,
                        ...init,{headers_addition}
                    }}
                ),
            ),
            (data) => options.unsafe ? data as {struct_name}Msg : {name}Msg.parse(data),
        )
    }}\n",
                // the function name
                name = name,
                // the request query parameter
                req_params = if self.req_params.is_some() {
                    format!("params: {struct_name}Params, ")
                } else {
                    String::new()
                },
                // where to fetch
                path = self.path,
                // make the query string
                params_suffix = if self.req_params.is_any() {
                    String::from(" + (params.size ? '?' + params : '')")
                } else if self.req_params.is_some() {
                    format!(
                        " + makeQuery(options.unsafe ? params as {struct_name}Params : \
                         {name}ParamsSchema.parse(params))"
                    )
                } else {
                    String::new()
                },
                // the method for fetching
                method = self.method,
                headers_addition = if self.req_body.is_schema() {
                    "\nheaders: jsonContentTypeHeader(init.headers as RepresentsHeader, \
                     options.globalInit.headers as RepresentsHeader),"
                } else {
                    ""
                },
            )?;
        } else if self.res_body.is_websocket() {
            write!(
                buffer,
                "    export function {name}({req_params}): {struct_name}Websocket {{
        const wsBaseUrl = new URL(options.baseUrl, typeof location !== 'undefined' ? location.href : undefined);

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
                req_params = if self.req_params.is_some() {
                    format!("params: {struct_name}Params, ")
                } else {
                    String::new()
                },
                // where to fetch
                path = self.path,
                // make the query string
                params_suffix = if self.req_params.is_any() {
                    String::from(" + (params.size ? '?' + params : '')")
                } else if self.req_params.is_some() {
                    format!(
                        " + makeQuery(options.unsafe ? params as {struct_name}Params : \
                         {name}ParamsSchema.parse(params))"
                    )
                } else {
                    String::new()
                },
            )?;
        } else {
            let mut parameters = Vec::new();

            if self.req_body.is_some() {
                parameters.push(format!("req: {struct_name}Req"));
            }

            if self.req_params.is_some() {
                parameters.push(format!("params: {struct_name}Params"));
            }

            if self.req_body.is_multipart() {
                parameters.push(String::from("files: (File | Blob)[] = []"));
            }

            parameters.push(String::from("init: RequestInit = {}"));

            write!(
                buffer,
                "    export function {name}({parameters}): PromiseWrapper<{res_name}> {{",
                // the function name
                name = name,
                // the parameters
                parameters = parameters.join(", "),
                // the response type
                res_name = if self.res_body.is_some() {
                    format!("{struct_name}Res")
                } else {
                    "Response".to_string()
                },
            )?;

            if let Kind::Multipart {
                json_name,
                files_name,
                ..
            } = &self.req_body
            {
                writeln!(buffer, "{TAB}const formData = new FormData();")?;

                writeln!(
                    buffer,
                    r#"{TAB}formData.set({json_name}, new Blob([JSON.stringify(req)], {{ type: 'application/json' }}));"#,
                    json_name = serde_json::to_string(json_name.as_ref())?,
                )?;

                writeln!(
                    buffer,
                    r#"{TAB}files.forEach((l) => formData.append({files_name}, l));"#,
                    files_name = serde_json::to_string(files_name.as_ref())?,
                )?;
            }

            write!(
                buffer,
                "
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
        )\n",
                // where to fetch
                path = self.path,
                // make the query string
                params_suffix = if self.req_params.is_any() {
                    String::from(" + (params.size ? '?' + params : '')")
                } else if self.req_params.is_some() {
                    format!(
                        " + makeQuery(options.unsafe ? params as {struct_name}Params : \
                         {name}ParamsSchema.parse(params))"
                    )
                } else {
                    String::new()
                },
                // the method for fetching
                method = self.method,
                // make the request body
                req = match &self.req_body {
                    Kind::None => "null".to_string(),
                    Kind::Any => "req".to_string(),
                    Kind::Schema(_) =>
                        format!("JSON.stringify({name}ReqSchema.parse(req))"),
                    Kind::Multipart { .. } => "formData".to_string(),
                    Kind::Websocket { .. } => unreachable!(),
                    Kind::SSE { .. } => unreachable!(),
                },
                headers_addition = if self.req_body.is_schema() {
                    "\nheaders: jsonContentTypeHeader(init.headers as RepresentsHeader, \
                     options.globalInit.headers as RepresentsHeader),"
                } else {
                    ""
                },
                // make the response
                res = match &self.res_body {
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
                    Kind::Multipart { .. } => unreachable!(),
                },
            )?;

            writeln!(buffer, "{TAB}}}")?;
        }

        Ok(())
    }
}
