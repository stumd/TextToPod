#!/bin/bash

# Check if correct number of arguments are provided
if [ $# -ne 2 ]; then
    echo "Usage: $0 <directory_path> <output_file_path>"
    exit 1
fi

directory_path="$1"
output_file_path="$2"

# Function to check if a file should be processed
should_process_file() {
    local file="$1"
    local filename=$(basename "$file")

    # Ignore hidden files and directories
    [[ "$filename" == .* ]] && return 1

    # Ignore common build directories
    [[ "$file" == */build/* ]] && return 1
    [[ "$file" == */dist/* ]] && return 1
    [[ "$file" == */node_modules/* ]] && return 1
    [[ "$file" == */vendor/* ]] && return 1

    # Ignore common artifact and cache directories
    [[ "$file" == */.git/* ]] && return 1
    [[ "$file" == */__pycache__/* ]] && return 1
    [[ "$file" == */.vscode/* ]] && return 1
    [[ "$file" == */.idea/* ]] && return 1
    [[ "$file" == */package-lock.json ]] && return 1
    [[ "$file" == */directory_contents.sh ]] && return 1

    # Include common development file types
    [[ "$file" == *.py ]] && return 0
    [[ "$file" == *.js ]] && return 0
    [[ "$file" == *.ts ]] && return 0
    [[ "$file" == *.html ]] && return 0
    [[ "$file" == *.css ]] && return 0
    [[ "$file" == *.scss ]] && return 0
    [[ "$file" == *.java ]] && return 0
    [[ "$file" == *.c ]] && return 0
    [[ "$file" == *.cpp ]] && return 0
    [[ "$file" == *.h ]] && return 0
    [[ "$file" == *.rb ]] && return 0
    [[ "$file" == *.php ]] && return 0
    [[ "$file" == *.go ]] && return 0
    [[ "$file" == *.md ]] && return 0
    [[ "$file" == *.yml ]] && return 0
    [[ "$file" == *.yaml ]] && return 0
    [[ "$file" == *.json ]] && return 0
    [[ "$file" == *.xml ]] && return 0
    [[ "$file" == *.sql ]] && return 0
    [[ "$file" == *.sh ]] && return 0
    [[ "$file" == Dockerfile ]] && return 0
    [[ "$file" == Makefile ]] && return 0

    # Exclude all other files
    return 1
}

# Function to get file size in a cross-platform way
get_file_size() {
    local file="$1"
    if [ -f "$file" ]; then
        wc -c < "$file" 2>/dev/null || echo "0"
    else
        echo "0"
    fi
}

# Function to process a file
process_file() {
    local file_path="$1"
    local file_size=$(get_file_size "$file_path")

    # Check if file size is less than or equal to 1MB (1000000 bytes)
    if [ "$file_size" -le 1000000 ] 2>/dev/null; then
        echo "File: $file_path" >> "$output_file_path"
        echo "Content:" >> "$output_file_path"
        cat "$file_path" >> "$output_file_path" 2>/dev/null || echo "Error reading file $file_path" >> "$output_file_path"
        echo -e "\n================================================================================\n" >> "$output_file_path"
    fi
}

# Main function to process directory
process_directory() {
    local dir="$1"

    # Use find to recursively find all files
    find "$dir" -type f | while read -r file; do
        if should_process_file "$file"; then
            process_file "$file"
        fi
    done
}

# Clear or create the output file
> "$output_file_path"

# Process the directory
process_directory "$directory_path"

echo "Output written to $output_file_path"