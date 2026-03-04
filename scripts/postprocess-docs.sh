#!/bin/bash

# Set the documentation directory path
DOCS_DIR="./docs"

# Check if the docs directory exists
if [ ! -d "$DOCS_DIR" ]; then
    echo "Error: Documentation directory '$DOCS_DIR' does not exist."
    echo "Please run 'pnpm docgen' first to generate the documentation."
    exit 1
fi

find "$DOCS_DIR" -name "*.md" -type f | while read -r file; do    
    temp_file=$(mktemp)

    awk '
        NR == 1 && /^# Solidity API$/ { next }

        # Detect start of a header like "## OrionConfig"
        /^## / {
            print $0
            in_header_block = 1
            next
        }

        # Skip lines between header and first normal sentence
        in_header_block {
            if ($0 ~ /^[[:space:]]*$/ ||
                $0 ~ /[█▄▀╔╗╚╝╠╣═║╦╩╬╭╮╯╰╱╲╳]/ ||
                $0 ~ /^[[:upper:][:space:][:punct:]]+$/) {
                next
            } else {
                in_header_block = 0
            }
        }

        {
            # Convert angle-bracketed URLs to markdown links
            while (match($0, /<https:\/\/[^>]+>/)) {
                url = substr($0, RSTART + 1, RLENGTH - 2)  # Extract URL without <>
                # Extract last path segment (after last /)
                n = split(url, parts, "/")
                text = parts[n]
                # Convert hyphens to spaces
                gsub(/-/, " ", text)
                # Replace <url> with [text](url)
                $0 = substr($0, 1, RSTART - 1) "[" text "](" url ")" substr($0, RSTART + RLENGTH)
            }

            # Clean up extra spaces
            gsub(/[[:space:]]+/, " ", $0)
            gsub(/^[[:space:]]+/, "", $0)
            gsub(/[[:space:]]+$/, "", $0)

            print
        }
    ' "$file" > "$temp_file"

    mv "$temp_file" "$file"
done
