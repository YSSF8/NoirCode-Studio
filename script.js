const textarea = document.getElementById('code');
const previewFrame = document.getElementById('previewFrame');
const errorMessage = document.getElementById('error-message');

/**
 * Compiles custom code to HTML.
 * @param {string} customCode - The custom code to compile.
 * @returns {Object} - An object containing the compiled HTML and any errors.
 */
function compileToHTML(customCode) {
    const lines = customCode.split('\n');
    let html = '';
    let errors = [];
    let i = 0;
    const totalLines = lines.length;
    let inBlockComment = false;

    while (i < totalLines) {
        let line = lines[i].trim();

        if (inBlockComment) {
            if (line.endsWith('#}')) {
                inBlockComment = false;
            }
            i++;
            continue;
        }

        if (line.startsWith('#{')) {
            inBlockComment = true;
            i++;
            continue;
        }

        line = removeInlineComments(line);

        if (line === '') {
            i++;
            continue;
        }

        if (line.startsWith('#')) {
            i++;
            continue;
        }

        const blockStartMatch = line.match(/^([\w-]+)(\[[^\]]+\])?(#[\w\-]+)?((?:\.[\w\-]+)*?)\\\{$/);
        if (blockStartMatch) {
            const tag = blockStartMatch[1].toLowerCase();
            const attrs = blockStartMatch[2] ? replaceIndexPlaceholders(blockStartMatch[2].slice(1, -1), 1) : '';
            const id = blockStartMatch[3] ? replaceIndexPlaceholders(blockStartMatch[3].slice(1), 1) : '';
            const classesRaw = blockStartMatch[4] ? blockStartMatch[4] : '';
            const classes = classesRaw.split('.').filter(cls => cls !== '');

            let blockContent = '';
            i++;
            let openBlocks = 1;

            while (i < totalLines && openBlocks > 0) {
                let currentLine = lines[i].trim();

                if (currentLine.endsWith('\\{')) {
                    openBlocks++;
                }

                if (currentLine === '\\}') {
                    openBlocks--;
                    if (openBlocks === 0) {
                        i++;
                        break;
                    }
                }

                if (openBlocks > 0) {
                    blockContent += lines[i] + '\n';
                }

                i++;
            }

            if (openBlocks > 0) {
                errors.push(`Unclosed block starting with <${tag}>.`);
                break;
            }

            let innerHTML = '';

            if (tag === 'script' || tag === 'style' || tag === 'html') {
                innerHTML = blockContent;
            } else if (tag === 'raw') {
                // Handle raw blocks by escaping content
                innerHTML = escapeHTML(blockContent);
                html += `${innerHTML}\n`;
                continue; // Skip the rest of the loop to avoid wrapping in a tag
            } else {
                let compiledBlock;
                try {
                    compiledBlock = compileToHTML(blockContent);
                } catch (error) {
                    errors.push(`Line ${i + 1}: Unexpected error: ${error.message}`);
                    compiledBlock = { html: '', errors: [`Line ${i + 1}: Unexpected error: ${error.message}`] };
                }

                if (compiledBlock.errors.length > 0) {
                    errors = errors.concat(compiledBlock.errors);
                }
                innerHTML = compiledBlock.html;
            }

            let attrString = '';
            if (attrs) attrString += ` ${attrs}`;
            if (id) attrString += ` id="${id}"`;
            if (classes.length > 0) attrString += ` class="${classes.join(' ')}"`;

            html += `<${tag}${attrString}>\n${innerHTML}</${tag}>\n`;

            continue;
        }

        const inlineMatch = line.match(/^([\w-]+)(\[[^\]]+\])?(#[\w\-]+)?((?:\.[\w\-]+)*?)(?:\{([^}]*)\})?(?:\*(\d+))?$/);
        if (inlineMatch) {
            try {
                const tag = inlineMatch[1].toLowerCase();
                const attrs = inlineMatch[2] ? inlineMatch[2].slice(1, -1) : '';
                const id = inlineMatch[3] ? inlineMatch[3].slice(1) : '';
                const classesRaw = inlineMatch[4] ? inlineMatch[4] : '';
                const classes = classesRaw.split('.').filter(cls => cls !== '');
                const content = inlineMatch[5] || '';
                const repeat = inlineMatch[6] ? parseInt(inlineMatch[6]) : 1;

                for (let j = 1; j <= repeat; j++) {
                    const currentContent = replaceIndexPlaceholders(content, j);
                    const finalAttributes = replaceIndexPlaceholders(attrs, j);
                    const finalId = replaceIndexPlaceholders(id, j);
                    const finalClasses = classes.map(cls => replaceIndexPlaceholders(cls, j));

                    let currentAttrString = '';
                    if (finalAttributes) currentAttrString += ` ${finalAttributes}`;
                    if (finalId) currentAttrString += ` id="${finalId}"`;
                    if (finalClasses.length > 0) currentAttrString += ` class="${finalClasses.join(' ')}"`;

                    html += `<${tag}${currentAttrString}>${currentContent}</${tag}>\n`;
                }

                i++;
            } catch (err) {
                errors.push(`Line ${i + 1}: ${err.message}`);
            }
            continue;
        }

        const siblingTokens = splitRespectingBlocks(line, '+');

        if (siblingTokens.length > 1) {
            const firstToken = siblingTokens[0];
            const firstNestingTokens = splitRespectingBlocks(firstToken, '>');
            let parentHTML = processNesting(firstNestingTokens, 0, errors, i + 1);

            const parentTag = extractTagName(firstToken);
            if (!parentTag) {
                errors.push(`Line ${i + 1}: Unable to determine parent tag from "${firstToken}".`);
                i++;
                continue;
            }

            let siblingsHTML = '';
            for (let j = 1; j < siblingTokens.length; j++) {
                const siblingToken = siblingTokens[j];
                const siblingNestingTokens = splitRespectingBlocks(siblingToken, '>');
                const siblingHTML = processNesting(siblingNestingTokens, 0, errors, i + 1);
                siblingsHTML += siblingHTML;
            }

            const closingTag = `</${parentTag}>`;
            const closingTagIndex = parentHTML.lastIndexOf(closingTag);
            if (closingTagIndex !== -1) {
                parentHTML = parentHTML.slice(0, closingTagIndex) + siblingsHTML + '\n' + parentHTML.slice(closingTagIndex);
            } else {
                parentHTML += siblingsHTML;
            }

            html += parentHTML + '\n';
        } else {
            const token = siblingTokens[0];
            const nestingTokens = splitRespectingBlocks(token, '>');
            const nestedHTML = processNesting(nestingTokens, 0, errors, i + 1);
            html += nestedHTML + '\n';
        }

        i++;
    }

    try {
        html = processInlineJS(html, errors);
    } catch (error) {
        errors.push(`Inline JS Error: ${error.message}`);
    }

    return { html, errors };

    /**
     * Extracts the tag name from a token.
     * @param {string} token - The token to extract the tag from.
     * @returns {string|null} - The extracted tag name or null if not found.
     */
    function extractTagName(token) {
        const match = token.match(/^([\w-]+)/);
        return match ? match[1].toLowerCase() : null;
    }

    /**
     * Processes and replaces inline JavaScript expressions within the HTML.
     * @param {string} htmlContent - The HTML content to process.
     * @param {Array} errors - The array to collect any errors.
     * @returns {string} - The HTML with inline JavaScript expressions evaluated.
     */
    function processInlineJS(htmlContent, errors) {
        const jsRegex = /<\$\s*([\s\S]+?)\s*\$>/g;
        return htmlContent.replace(jsRegex, (match, p1) => {
            try {
                const iframeWindow = previewFrame.contentWindow;

                if (!iframeWindow) {
                    throw new Error("Preview frame's window is not accessible.");
                }

                const result = iframeWindow.eval(p1);

                return result !== undefined ? escapeHTML(result.toString()) : '';
            } catch (err) {
                errors.push(`Inline JS Evaluation Error: ${err.message} in expression "${p1}"`);
                return `<span style="color: red;">Error</span>`;
            }
        });
    }

    /**
     * Recursive function to process nested tokens.
     * @param {Array} nestingTokens - Array of tokens split by '>'.
     * @param {number} index - Current index in the nestingTokens array.
     * @param {Array} errors - Array to collect error messages.
     * @param {number} lineNumber - Current line number for error reporting.
     * @returns {string} - The generated HTML string after processing nesting.
     */
    function processNesting(nestingTokens, index, errors, lineNumber) {
        if (index >= nestingTokens.length) return '';

        const nestedToken = nestingTokens[index].trim();
        const isLast = index === nestingTokens.length - 1;

        if (nestedToken === '') return '';

        let generatedHTML = '';

        try {
            const { tag, attributes, id, classes, content, repeat } = parseElement(nestedToken, lineNumber);

            for (let j = 1; j <= repeat; j++) {
                const finalAttributes = replaceIndexPlaceholders(attributes, j);
                const finalId = replaceIndexPlaceholders(id, j);
                const finalClasses = classes.map(cls => replaceIndexPlaceholders(cls, j));
                const finalContent = replaceIndexPlaceholders(content, j);

                let finalAttrString = '';
                if (finalAttributes) finalAttrString += ` ${finalAttributes}`;
                if (finalId) finalAttrString += ` id="${finalId}"`;
                if (finalClasses.length > 0) finalAttrString += ` class="${finalClasses.join(' ')}"`;

                generatedHTML += `<${tag}${finalAttrString}>`;

                if (finalContent) {
                    generatedHTML += finalContent;
                }

                if (!isLast) {
                    generatedHTML += '\n';
                    generatedHTML += processNesting(nestingTokens, index + 1, errors, lineNumber);
                    generatedHTML += `</${tag}>\n`;
                } else {
                    generatedHTML += `</${tag}>\n`;
                }
            }
        } catch (err) {
            if (nestedToken.startsWith('\\}')) {
                return '';
            } else {
                errors.push(`Line ${lineNumber}: ${err.message}`);
                generatedHTML += `${escapeHTML(nestedToken)}\n`;
            }
        }

        return generatedHTML;
    }
}

/**
 * Removes inline comments from a line of code.
 * @param {string} line - The line of code to process.
 * @returns {string} - The line without inline comments.
 */
function removeInlineComments(line) {
    let inQuotes = false;
    let quoteChar = '';
    let escape = false;

    for (let i = 0; i < line.length; i++) {
        let char = line[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            continue;
        }

        if ((char === '"' || char === "'") && !inQuotes) {
            inQuotes = true;
            quoteChar = char;
            continue;
        }

        if (char === quoteChar && inQuotes) {
            inQuotes = false;
            quoteChar = '';
            continue;
        }

        if (!inQuotes && char === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.substring(0, i).trim();
        }
    }

    return line;
}

/**
 * Splits a string by a delimiter but ignores delimiters inside quotes or blocks.
 * @param {string} str - The string to split.
 * @param {string} delimiter - The delimiter to split by.
 * @returns {Array} - Array of split tokens.
 */
function splitRespectingBlocks(str, delimiter) {
    const tokens = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    let escape = false;
    let blockDepth = 0;

    for (let i = 0; i < str.length; i++) {
        let char = str[i];

        if (escape) {
            current += char;
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            current += char;
            continue;
        }

        if ((char === '"' || char === "'") && !inQuotes) {
            inQuotes = true;
            quoteChar = char;
            current += char;
            continue;
        }

        if (char === quoteChar && inQuotes) {
            inQuotes = false;
            quoteChar = '';
            current += char;
            continue;
        }

        if (!inQuotes && char === '{') {
            blockDepth++;
            current += char;
            continue;
        }

        if (!inQuotes && char === '}') {
            blockDepth = Math.max(blockDepth - 1, 0);
            current += char;
            continue;
        }

        if (!inQuotes && blockDepth === 0 && char === delimiter) {
            tokens.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    if (current !== '') {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Replaces all instances of &index; with the provided index number.
 * @param {string} str - The string to process.
 * @param {number} index - The index to replace &index; with.
 * @returns {string} - The processed string.
 */
function replaceIndexPlaceholders(str, index) {
    return str.replace(/&index;/g, index);
}

/**
 * Parses an element definition from the custom syntax.
 * @param {string} token - A token from the custom code.
 * @param {number} lineNumber - The line number for error reporting.
 * @returns {Object} - Parsed element details.
 */
function parseElement(token, lineNumber) {
    const regex = /^([\w-]+)(\[[^\]]+\])?(#[\w\-]+)?((?:\.[\w\-]+)*?)(?:\{([^}]*)\})?(?:\*(\d+))?$/;
    const match = token.match(regex);

    if (!match) {
        throw { message: `Invalid syntax near "${token}".`, line: lineNumber };
    }

    const [, tag, attrs, id, classNames, content, repeat] = match;

    const attributes = attrs ? attrs.slice(1, -1) : '';
    const classes = classNames ? classNames.split('.').filter(cls => cls !== '').map(cls => cls.trim()) : [];

    const element = {
        tag: tag,
        attributes: attributes,
        id: id ? id.slice(1) : '',
        classes: classes,
        content: content || '',
        repeat: repeat ? parseInt(repeat) : 1
    };

    return element;
}

/**
 * Escapes HTML special characters in a string.
 * @param {string} str - The string to escape.
 * @returns {string} - The escaped string.
 */
function escapeHTML(str) {
    const replacements = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return str.replace(/[&<>"']/g, match => replacements[match]);
}

function updatePreview() {
    const textarea = document.getElementById('code');
    const previewFrame = document.getElementById('previewFrame');
    const errorMessage = document.getElementById('error-message');

    const customCode = textarea.value;
    let compilationResult;
    try {
        compilationResult = compileToHTML(customCode);
    } catch (error) {
        compilationResult = { html: '', errors: [`Unexpected error: ${error.message}`] };
    }

    const { html, errors } = compilationResult;

    if (errors && errors.length > 0) {
        errorMessage.textContent = errors.join(' | ');
        errorMessage.style.display = 'block';
        previewFrame.srcdoc = '';
    } else {
        errorMessage.textContent = '';
        errorMessage.style.display = 'none';
        const fullHTML = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Preview</title>
            <style>
                body {
                    background-color: #1e1e1e;
                    color: #cccccc;
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    padding: 20px;
                }
                h1, h2, h3, h4, h5, h6 {
                    color: #ffffff;
                }
                p {
                    color: #dcdcdc;
                    margin-bottom: 10px;
                }
                button {
                    padding: 10px 20px;
                    background-color: #3498db;
                    color: #fff;
                    border: none;
                    cursor: pointer;
                    border-radius: 4px;
                    margin-top: 10px;
                }
                button:hover {
                    background-color: #2980b9;
                }
                a {
                    color: #9b59b6;
                }
                a:hover {
                    color: #8e44ad;
                }
                /* Additional styles for various elements */
                ul {
                    list-style-type: disc;
                    padding-left: 20px;
                    margin-bottom: 10px;
                }
                li {
                    margin-bottom: 5px;
                }
                input, textarea {
                    background-color: #333333;
                    color: #ffffff;
                    border: 1px solid #555555;
                    padding: 8px;
                    border-radius: 4px;
                    margin-top: 5px;
                }
                input:focus, textarea:focus {
                    border-color: #3498db;
                    outline: none;
                }
                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-top: 10px;
                }
                th, td {
                    border: 1px solid #555555;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #444444;
                }
                tr:nth-child(even) {
                    background-color: #2d2d2d;
                }
                /* Embedded Styles */
                ${extractEmbeddedStyles(html)}
            </style>
        </head>
        <body>
        ${html}
        </body>
        </html>`;
        previewFrame.srcdoc = fullHTML;
    }
}

/**
 * Extracts embedded <style> blocks from the generated HTML to include in the preview's head.
 * @param {string} html - The generated HTML content.
 * @returns {string} - Extracted CSS from <style> blocks.
 */
function extractEmbeddedStyles(html) {
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styles = '';
    let match;
    while ((match = styleRegex.exec(html)) !== null) {
        styles += match[1] + '\n';
    }
    return styles;
}

updatePreview();

let timeout;
const textareaElement = document.getElementById('code');

textareaElement.addEventListener('input', () => {
    clearTimeout(timeout);
    timeout = setTimeout(updatePreview, 300);
});

const tabEditor = document.getElementById('tab-editor');
const tabPreview = document.getElementById('tab-preview');
const editor = document.querySelector('.editor');
const preview = document.querySelector('.preview');

/**
 * Activates the specified tab and deactivates the other.
 * @param {string} tab - The tab to activate ('editor' or 'preview').
 */
function activateTab(tab) {
    tabEditor.classList.remove('active');
    tabPreview.classList.remove('active');

    editor.classList.remove('active');
    preview.classList.remove('active');

    if (tab === 'editor') {
        tabEditor.classList.add('active');
        editor.classList.add('active');
    } else if (tab === 'preview') {
        tabPreview.classList.add('active');
        preview.classList.add('active');
    }

    handleResponsiveTabs();
}

function handleResponsiveTabs() {
    const isMobile = window.innerWidth <= 768;

    if (isMobile) {
        if (!editor.classList.contains('active') && !preview.classList.contains('active')) {
            editor.classList.add('active');
        }
    } else {
        editor.classList.add('active');
        preview.classList.add('active');
    }
}

handleResponsiveTabs();

window.addEventListener('resize', handleResponsiveTabs);

tabEditor.addEventListener('click', () => activateTab('editor'));
tabPreview.addEventListener('click', () => activateTab('preview'));

textareaElement.addEventListener('keydown', e => {
    const openingChars = {
        '"': '"',
        "'": "'",
        '(': ')',
        '{': '}',
        '[': ']',
        '<': '>'
    };

    const closingChars = Object.values(openingChars);

    if (e.key === 'Backspace') {
        const cursorPos = textareaElement.selectionStart;
        const textBeforeCursor = textareaElement.value.substring(0, cursorPos);
        const lastTwoChars = textBeforeCursor.slice(-2);
        return;
    }

    if (e.key === '"' || e.key === "'") {
        const closingChar = openingChars[e.key];
        const cursorPos = textareaElement.selectionStart;
        const beforeCursor = textareaElement.value.substring(0, cursorPos);
        const afterCursor = textareaElement.value.substring(cursorPos);

        if (afterCursor.startsWith(closingChar)) {
            e.preventDefault();
            textareaElement.setSelectionRange(cursorPos + 1, cursorPos + 1);
        } else {
            e.preventDefault();
            textareaElement.value = beforeCursor + e.key + closingChar + afterCursor;
            setTimeout(() => {
                textareaElement.setSelectionRange(cursorPos + 1, cursorPos + 1);
                textareaElement.dispatchEvent(new Event('input'));
            }, 0);
        }
        return;
    }

    if (e.key in openingChars) {
        e.preventDefault();
        const closingChar = openingChars[e.key];
        const cursorPos = textareaElement.selectionStart;
        const beforeCursor = textareaElement.value.substring(0, cursorPos);
        const afterCursor = textareaElement.value.substring(cursorPos);

        textareaElement.value = beforeCursor + e.key + closingChar + afterCursor;
        setTimeout(() => {
            textareaElement.setSelectionRange(cursorPos + e.key.length, cursorPos + e.key.length);
            textareaElement.dispatchEvent(new Event('input'));
        }, 0);
    }

    if (e.key === 'Tab') {
        e.preventDefault();

        const start = textareaElement.selectionStart;
        const end = textareaElement.selectionEnd;

        const value = textareaElement.value;
        const newValue = value.substring(0, start) + '  ' + value.substring(end);

        textareaElement.value = newValue;

        textareaElement.selectionStart = textareaElement.selectionEnd = start + 2;

        textareaElement.dispatchEvent(new Event('input'));
    }

    if (closingChars.includes(e.key)) {
        const cursorPos = textareaElement.selectionStart;
        const nextChar = textareaElement.value.substring(cursorPos, cursorPos + 1);
        if (e.key === nextChar) {
            e.preventDefault();
            textareaElement.setSelectionRange(cursorPos + 1, cursorPos + 1);
        }
    }
});