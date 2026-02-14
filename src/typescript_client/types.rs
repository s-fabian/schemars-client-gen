use std::fmt::Write;

use schemars_to_zod::{Config, DateFormat, Parser};
use serde::de::StdError;

use crate::{
    typescript_client::{first_upper, TAB},
    Kind,
    RequestInfo,
};

impl RequestInfo {
    pub(crate) fn append_req_params_type(
        &self,
        name: &str,
        buffer: &mut String,
    ) -> Result<(), Box<dyn StdError>> {
        let struct_name = first_upper(name);
        let i_url_parser = Parser::new(Config {
            date_format: DateFormat::DateToJson,
            ignore_undefined: false,
            prefer_unknown: true,
        });

        match &self.req_params {
            Kind::None => {},

            Kind::Any => {
                write!(
                    buffer,
                    "{TAB}export type {struct_name}Params = URLSearchParams;\n\n"
                )?;
            },

            Kind::Schema(schema) => {
                let zod = i_url_parser
                    .parse_schema_object(&schema.schema)
                    .inspect_err(|_| {
                        #[cfg(feature = "binary")]
                        eprintln!("Error in client schema generation of: {name}")
                    })?;

                writeln!(buffer, "{TAB}const {name}ParamsSchema = {};", zod)?;
                write!(
                    buffer,
                    "{TAB}export type {struct_name}Params = z.input<typeof \
                     {name}ParamsSchema>;\n\n"
                )?;
            },

            kind => panic!("Unexpected kind: {kind}"),
        };
        Ok(())
    }

    pub(crate) fn append_req_body_type(
        &self,
        name: &str,
        buffer: &mut String,
    ) -> Result<(), Box<dyn StdError>> {
        let struct_name = first_upper(name);
        let i_body_parser = Parser::new(Config {
            date_format: DateFormat::JsDate,
            ignore_undefined: false,
            prefer_unknown: true,
        });

        match &self.req_body {
            Kind::None => {},

            Kind::Any => {
                write!(
                    buffer,
                    "{TAB}type {struct_name}Req = Blob | FormData | string;\n\n"
                )?;
            },

            Kind::Schema(schema) | Kind::Multipart { schema, .. } => {
                let zod = i_body_parser
                    .parse_schema_object(&schema.schema)
                    .inspect_err(|_| {
                        #[cfg(feature = "binary")]
                        eprintln!("Error in client schema generation of: {name}")
                    })?;
                writeln!(buffer, "{TAB}const {name}ReqSchema = {};", zod)?;
                write!(
                    buffer,
                    "{TAB}export type {struct_name}Req = z.input<typeof \
                     {name}ReqSchema>;\n\n"
                )?;
            },

            kind => panic!("Unexpected kind: {kind}"),
        };

        Ok(())
    }

    pub(crate) fn append_res_body_type(
        &self,
        name: &str,
        buffer: &mut String,
    ) -> Result<(), Box<dyn StdError>> {
        let struct_name = first_upper(name);
        let o_parser = Parser::new(Config {
            #[cfg(feature = "keep-datestring")]
            date_format: DateFormat::IsoStringDate,
            #[cfg(not(feature = "keep-datestring"))]
            date_format: DateFormat::CoerceDate,
            #[cfg(feature = "add-undefined")]
            ignore_undefined: false,
            #[cfg(not(feature = "add-undefined"))]
            ignore_undefined: true,
            #[cfg(feature = "prefer-any")]
            prefer_unknown: false,
            #[cfg(not(feature = "prefer-any"))]
            prefer_unknown: true,
        });
        let i_body_parser = Parser::new(Config {
            date_format: DateFormat::JsDate,
            ignore_undefined: false,
            prefer_unknown: true,
        });

        match &self.res_body {
            Kind::None => {},
            Kind::Any => {
                write!(buffer, "    export type {struct_name}Res = unknown;\n\n")?;
            },
            Kind::Schema(schema) => {
                let zod =
                    o_parser
                        .parse_schema_object(&schema.schema)
                        .inspect_err(|_| {
                            #[cfg(feature = "binary")]
                            eprintln!("Error in server schema generation of: {name}")
                        })?;

                writeln!(buffer, "    const {name}ResSchema = {};", zod)?;
                write!(
                    buffer,
                    "    export type {struct_name}Res = z.output<typeof \
                     {name}ResSchema>;\n\n"
                )?;
            },
            Kind::Websocket {
                client_msg,
                server_msg,
            } => {
                let client_msg = i_body_parser
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

                writeln!(
                    buffer,
                    "    const {name}ClientMsgSchema = {};",
                    client_msg
                )?;
                writeln!(
                    buffer,
                    "    export type {struct_name}ClientMsg = z.output<typeof \
                     {name}ClientMsgSchema>;"
                )?;

                writeln!(
                    buffer,
                    "    const {name}ServerMsgSchema = {};",
                    server_msg
                )?;
                writeln!(
                    buffer,
                    "    export type {struct_name}ServerMsg = z.output<typeof \
                     {name}ServerMsgSchema>;"
                )?;

                writeln!(
                    buffer,
                    "    export type {struct_name}Websocket = \
                     WebsocketWrapper<{struct_name}ClientMsg, \
                     {struct_name}ServerMsg>;\n"
                )?;
            },
            Kind::SSE(schema) => {
                let zod =
                    o_parser
                        .parse_schema_object(&schema.schema)
                        .inspect_err(|_| {
                            #[cfg(feature = "binary")]
                            eprintln!("Error in server schema generation of: {name}")
                        })?;

                writeln!(buffer, "    const {name}Msg = {};", zod)?;
                writeln!(
                    buffer,
                    "    export type {struct_name}Msg = z.output<typeof {name}Msg>;\n"
                )?;
                writeln!(
                    buffer,
                    "    export type {struct_name}SSE = SSE<{struct_name}Msg>;\n"
                )?;
            },

            kind => panic!("Unexpected kind: {kind}"),
        };

        Ok(())
    }
}
