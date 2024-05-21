#[cfg(all(not(feature = "client-gen"), feature = "binary"))]
fn main() {
    eprintln!("Feature 'client-gen' is not available");
}

#[cfg(all(not(feature = "binary"), feature = "client-gen"))]
fn main() {
    eprintln!("Feature 'binary' is not available");
}

#[cfg(all(not(feature = "binary"), not(feature = "client-gen")))]
fn main() {
    eprintln!("Feature 'binary' and 'client-gen' are not available");
}

#[cfg(all(feature = "client-gen", feature = "binary"))]
mod binary {
    use std::{error::Error as StdError, fs, io::Read, path::PathBuf};

    use clap::Parser;
    use schemars_client_gen::{generate, RequestInfo, Requests};

    /// Create a client.ts file from
    #[derive(Parser, Debug)]
    #[command(version, about, long_about = None)]
    struct Args {
        /// The input json file to generate the client from.
        /// If no file is provided, it is read from stdin
        #[arg(short, long)]
        file: Option<PathBuf>,

        /// The output file to generate the client into.
        /// If no file is provided, it is output to stdout
        #[arg(short, long)]
        output_file: Option<PathBuf>,

        /// If the input contains a "wrapper" object
        #[arg(short, long, default_value_t = true)]
        wrapper: bool,
    }

    pub(super) fn main() -> Result<(), Box<dyn StdError>> {
        let args = Args::parse();

        if let Some(ref file) = args.file {
            if !file.exists() {
                return Err(String::from("Provided input path does not exist").into());
            }

            if !file.is_file() {
                return Err(String::from("Provided input path is not a file").into());
            }
        }

        if let Some(ref file) = args.output_file {
            if file.exists() && !file.is_file() {
                return Err(String::from("Provided output path is not a file").into());
            }
        }

        let input = match args.file {
            Some(file) => fs::read_to_string(file)?,
            None => {
                let mut input = Vec::new();
                let stdin = std::io::stdin();
                let mut handle = stdin.lock();
                handle.read_to_end(&mut input)?;
                String::from_utf8(input)?
            },
        };

        let json: Vec<RequestInfo> = match args.wrapper {
            true => {
                let json: Requests = serde_json::from_str(&input)?;
                json.requests
            },
            false => serde_json::from_str(&input)?,
        };

        let out = generate(Requests { requests: json })?;

        match args.output_file {
            Some(file) => fs::write(file, out)?,
            None => println!("{out}"),
        }

        eprintln!("Success!");

        Ok(())
    }
}

#[cfg(all(feature = "client-gen", feature = "binary"))]
fn main() -> Result<(), Box<dyn std::error::Error>> { binary::main() }
