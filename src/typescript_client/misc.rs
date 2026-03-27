use std::fmt::Write;

use serde::de::StdError;

use crate::{
    typescript_client::{make_name_raw, namespace_name, TAB},
    Deprecated,
    RequestInfo,
};

impl RequestInfo {
    pub(crate) fn append_deprecation(
        &self,
        _name: &str,
        buffer: &mut String,
    ) -> Result<(), Box<dyn StdError>> {
        match &self.deprecated {
            Deprecated::WithInfo(path, method, tag) => {
                let new =
                    make_name_raw(method.to_string(), path.to_string(), tag.to_string());

                if tag != &self.tag {
                    let tag = namespace_name(tag);

                    writeln!(
                        buffer,
                        "    /** @deprecated Please use {{@link {tag}.{new}}} instead */",
                    )?;
                } else {
                    writeln!(
                        buffer,
                        "    /** @deprecated Please use {{@link {new}}} instead */",
                    )?;
                }
            },
            Deprecated::Simple(true) => {
                writeln!(buffer, "    /** @deprecated */")?;
            },
            _ => {},
        }

        Ok(())
    }

    pub(crate) fn append_error_codes(
        &self,
        _name: &str,
        buffer: &mut String,
    ) -> Result<(), Box<dyn StdError>> {
        if !self.error_codes.is_empty() {
            write!(
                buffer,
                "{TAB}/**\n{TAB} * Error responses:\n{TAB} *\n{TAB} * {}\n{TAB} */\n",
                self.error_codes
                    .iter()
                    .map(|(code, info)| { format!("{code}: {info}") })
                    .collect::<Vec<String>>()
                    .join(&format!("\n{TAB} *\n{TAB} * ")),
            )?;
        }

        Ok(())
    }
}
