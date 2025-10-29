const API_URL = 'https://en.wikipedia.org/w/api.php';
const cache = new Map();

// Home category persistence
async function saveHomeCategory(category) {
    try {
        await chrome.storage.local.set({ homeCategory: category });
    } catch (err) {
        console.error('Error saving home category:', err);
    }
}

async function loadHomeCategory() {
    try {
        const result = await chrome.storage.local.get('homeCategory');
        return result.homeCategory || 'Articles';
    } catch (err) {
        console.error('Error loading home category:', err);
        return 'Articles';
    }
}

async function openInMainWindow(url) {
    try {
        const [targetTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (targetTab && typeof targetTab.id === 'number') {
            let parsed;
            let canInject = false;
            try {
                parsed = new URL(url, 'https://dummy.invalid');
                const scheme = parsed.protocol.toLowerCase();
                const forbiddenSchemes = new Set(['chrome:', 'chrome-extension:', 'edge:', 'about:']);
                canInject = !forbiddenSchemes.has(scheme);
            } catch (parseErr) {
                canInject = false;
            }

            // Also avoid injecting into restricted pages like chrome://newtab
            try {
                const activeUrl = targetTab.url || '';
                const activeScheme = new URL(activeUrl, 'https://dummy.invalid').protocol.toLowerCase();
                if (['chrome:', 'chrome-extension:', 'edge:', 'about:'].includes(activeScheme)) {
                    canInject = false;
                }
            } catch (_) {
                // If we cannot parse, err on the side of not injecting
                canInject = false;
            }

            if (chrome.scripting && chrome.scripting.executeScript && canInject) {
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: targetTab.id },
                        func: (navigateTo) => {
                            try {
                                window.location.assign(navigateTo);
                            } catch (innerErr) {
                                console.error('Navigation error inside tab context:', innerErr);
                            }
                        },
                        args: [url],
                        world: 'MAIN'
                    });
                    return;
                } catch (scriptErr) {
                    // Suppress noisy warnings for restricted pages or transient failures
                    // and proceed to chrome.tabs.update fallback silently.
                }
            }

            try {
                await chrome.tabs.update(targetTab.id, { url });
            } catch (updateErr) {
                // Silently ignore chrome:// URL errors - these happen on new tab pages
                if (updateErr.message && updateErr.message.includes('chrome://')) {
                    // No-op: cannot navigate from restricted pages
                    return;
                }
                throw updateErr;
            }
        } else {
            await chrome.tabs.create({ url });
        }
    } catch (err) {
        // Silently ignore chrome:// URL errors
        if (err.message && err.message.includes('chrome://')) {
            // No-op: cannot navigate from restricted pages
            return;
        }
        console.error('Failed to navigate using chrome.tabs.*:', err);
        try {
            await chrome.tabs.create({ url });
        } catch (createErr) {
            console.error('Failed to create fallback tab:', createErr);
        }
    }
}

function openInNewTab(url) {
    chrome.tabs.create({url: url});
}

async function openLink(url) {
    // If we're in a popup window, always open in new tab to avoid overwriting the extension UI
    try {
        const currentWindow = await chrome.windows.getCurrent();
        if (currentWindow.type === 'popup') {
            openInNewTab(url);
            return;
        }
    } catch (err) {
        console.error('Error detecting window type:', err);
    }

    // Check user preference for link target
    const stored = await chrome.storage.local.get('linkTarget');
    const mode = stored.linkTarget || 'current';

    if (mode === 'new') {
        openInNewTab(url);
    } else {
        await openInMainWindow(url);
    }
}

function normalizeCategory(name) {
    return name.replace(/_/g, ' ').trim();
}
// Track current view across the panel
window.__currentView = window.__currentView || 'main';

// Global view switcher (main vs settings)
function showOnlyView(view) {
    const inputSectionEl = document.getElementById('input-section');
    const splitViewEl = document.getElementById('split-view');
    const settingsEl = document.getElementById('settings-viewer');
    const catPanel = document.getElementById('current-page-categories-panel');

    window.__currentView = view;
    try { document.body && document.body.setAttribute('data-view', view); } catch (_) {}

    if (settingsEl) settingsEl.style.display = 'none';

    if (view === 'main') {
        if (inputSectionEl) inputSectionEl.style.display = 'block';
        if (splitViewEl) splitViewEl.style.display = 'flex';
        if (catPanel && window.updateCurrentPageCategories) {
            window.updateCurrentPageCategories();
        }
    } else if (view === 'settings') {
        if (inputSectionEl) inputSectionEl.style.display = 'none';
        if (splitViewEl) splitViewEl.style.display = 'none';
        if (catPanel) catPanel.style.display = 'none';
        if (settingsEl) {
            settingsEl.style.display = 'flex';
            settingsEl.style.flexDirection = 'column';
        }
    }
}

 

 
 


function getCategoryUrl(categoryName) {
    const normalized = categoryName.replace('Category:', '');
    return `https://en.wikipedia.org/wiki/Category:${encodeURIComponent(normalized)}`;
}

async function categoryExists(categoryName) {
    try {
        const params = new URLSearchParams({
            action: 'query',
            titles: `Category:${categoryName}`,
            format: 'json',
            origin: '*'
        });
        const response = await fetch(`${API_URL}?${params}`);
        const data = await response.json();
        if (!data.query || !data.query.pages) return false;
        const pages = data.query.pages;
        const page = Object.values(pages)[0];
        return !page.missing && !page.invalid && page.pageid > 0;
    } catch (err) {
        console.error('Error checking category:', err);
        return false;
    }
}

async function searchCategories(prefix, limit = 10) {
    try {
        // Use opensearch which is more forgiving with case
        const params = new URLSearchParams({
            action: 'opensearch',
            search: `Category:${prefix}`,
            namespace: '14', // Category namespace
            limit: limit,
            format: 'json',
            origin: '*'
        });
        const response = await fetch(`${API_URL}?${params}`);
        const data = await response.json();

        // OpenSearch returns array: [query, [titles], [descriptions], [urls]]
        if (!data[1] || data[1].length === 0) return [];

        // Remove "Category:" prefix from results
        return data[1].map(title => title.replace('Category:', ''));
    } catch (err) {
        console.error('Error searching categories:', err);
        return [];
    }
}

async function searchPages(searchTerm, limit = 10) {
    try {
        const params = new URLSearchParams({
            action: 'opensearch',
            search: searchTerm,
            limit: limit,
            namespace: '0',
            format: 'json',
            origin: '*'
        });
        const response = await fetch(`${API_URL}?${params}`);
        const data = await response.json();
        // opensearch returns [searchterm, [results], [descriptions], [urls]]
        if (!data || !data[1]) return [];
        return data[1];
    } catch (err) {
        console.error('Error searching pages:', err);
        return [];
    }
}

async function fetchCategoriesForPage(pageName) {
    try {
        const params = new URLSearchParams({
            action: 'query',
            titles: pageName,
            prop: 'categories',
            cllimit: '500',
            clshow: '!hidden',
            format: 'json',
            origin: '*'
        });
        const response = await fetch(`${API_URL}?${params}`);
        const data = await response.json();
        const pages = data.query.pages;
        const page = Object.values(pages)[0];

        if (!page.categories) return [];

        return page.categories
            .filter(cat => !cat.hidden)
            .map(cat => normalizeCategory(cat.title.replace('Category:', '')))
            .filter(name => !name.startsWith('Wikipedia:') && !name.startsWith('Articles ') && !name.startsWith('Pages '));
    } catch (err) {
        console.error('Error fetching categories for page:', err);
        return [];
    }
}

async function fetchParentCategories(categoryName) {
    const cacheKey = `parent_${categoryName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const params = new URLSearchParams({
        action: 'query',
        titles: `Category:${categoryName}`,
        prop: 'categories',
        cllimit: '500',
        clshow: '!hidden',
        format: 'json',
        origin: '*'
    });

    const response = await fetch(`${API_URL}?${params}`);
    const data = await response.json();
    const pages = data.query.pages;
    const page = Object.values(pages)[0];

    if (!page.categories) {
        cache.set(cacheKey, []);
        return [];
    }

    const parents = page.categories
        .filter(cat => !cat.hidden)
        .map(cat => normalizeCategory(cat.title.replace('Category:', '')))
        .filter(name => !name.startsWith('Wikipedia:') && !name.startsWith('Articles ') && !name.startsWith('Pages '));

    cache.set(cacheKey, parents);
    return parents;
}

async function fetchSubcategories(categoryName) {
    const cacheKey = `child_${categoryName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const params = new URLSearchParams({
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${categoryName}`,
        cmtype: 'subcat',
        cmlimit: '500',
        format: 'json',
        origin: '*'
    });

    const response = await fetch(`${API_URL}?${params}`);
    const data = await response.json();
    const subcategories = data.query.categorymembers.map(cat => normalizeCategory(cat.title.replace('Category:', '')));
    cache.set(cacheKey, subcategories);
    return subcategories;
}

async function fetchPagesInCategory(categoryName) {
    const cacheKey = `pages_${categoryName}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const params = new URLSearchParams({
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${categoryName}`,
        cmtype: 'page',
        cmlimit: '500',
        format: 'json',
        origin: '*'
    });

    const response = await fetch(`${API_URL}?${params}`);
    const data = await response.json();
    const pages = data.query.categorymembers.map(page => ({
        title: page.title,
        pageid: page.pageid
    }));

    // Check if there are more pages (continuation token)
    const hasMore = data.continue !== undefined;

    const result = {
        pages: pages,
        hasMore: hasMore
    };

    cache.set(cacheKey, result);
    return result;
}



function createNodeElement(categoryName, level = 0, showParents = true) {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'tree-node';
    nodeDiv.dataset.category = categoryName;
    nodeDiv.dataset.expanded = 'false';
    nodeDiv.dataset.loaded = 'false';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'node-content';

    const expandArea = document.createElement('div');
    expandArea.className = 'expand-area';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = categoryName;
    label.title = categoryName;

    expandArea.appendChild(expandIcon);
    expandArea.appendChild(label);

    const link = document.createElement('a');
    link.className = 'category-link';
    link.href = getCategoryUrl(categoryName);
    link.textContent = '🔗';
    link.title = 'Open category page';
    link.onclick = async (e) => {
        // Allow Ctrl+Click, Cmd+Click, Shift+Click for opening in new tab/window
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            return; // Let browser handle it
        }
        e.preventDefault();
        e.stopPropagation();
        await openLink(getCategoryUrl(categoryName));
    };

    contentDiv.appendChild(expandArea);
    contentDiv.appendChild(link);

    if (showParents) {
        const parentBtn = document.createElement('button');
        parentBtn.className = 'parent-btn';
        parentBtn.textContent = '⬆';
        parentBtn.title = 'Load parent categories';
        parentBtn.onclick = (e) => {
            e.stopPropagation();
            toggleParents(nodeDiv, categoryName);
        };
        contentDiv.appendChild(parentBtn);

        const pathBtn = document.createElement('button');
        pathBtn.className = 'parent-btn';
        pathBtn.textContent = '▽';
        pathBtn.title = 'Open in inverted tree view (child->parents)';
        pathBtn.onclick = (e) => {
            e.stopPropagation();
            findPathsToRoot(nodeDiv, categoryName);
        };
        contentDiv.appendChild(pathBtn);
    }

    

    nodeDiv.appendChild(contentDiv);

    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'children-container';
    childrenContainer.style.display = 'none';
    nodeDiv.appendChild(childrenContainer);

    expandArea.onclick = () => toggleNode(nodeDiv, categoryName);

    return nodeDiv;
}

function createPagesFolderElement(categoryName) {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'tree-node pages-folder';
    nodeDiv.dataset.category = categoryName;
    nodeDiv.dataset.expanded = 'false';
    nodeDiv.dataset.loaded = 'false';

    const contentDiv = document.createElement('div');
    contentDiv.className = 'node-content';

    const expandArea = document.createElement('div');
    expandArea.className = 'expand-area';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'node-label';
    label.style.color = 'var(--text-secondary)';
    label.style.fontStyle = 'italic';
    label.textContent = '(pages)';

    // Will be populated with count if there are more pages
    const countLabel = document.createElement('span');
    countLabel.className = 'node-label';
    countLabel.style.color = 'var(--text-secondary)';
    countLabel.style.fontStyle = 'italic';
    countLabel.style.marginLeft = '0px';

    expandArea.appendChild(expandIcon);
    expandArea.appendChild(label);
    expandArea.appendChild(countLabel);
    contentDiv.appendChild(expandArea);

    // No parent/path/wiki buttons for pages folder

    nodeDiv.appendChild(contentDiv);

    const pagesContainer = document.createElement('div');
    pagesContainer.className = 'children-container';
    pagesContainer.style.display = 'none';
    nodeDiv.appendChild(pagesContainer);

    expandArea.onclick = async () => {
        const isExpanded = nodeDiv.dataset.expanded === 'true';
        const isLoaded = nodeDiv.dataset.loaded === 'true';

        if (isExpanded) {
            nodeDiv.dataset.expanded = 'false';
            expandIcon.classList.remove('expanded');
            pagesContainer.style.display = 'none';
            return;
        }

        if (!isLoaded) {
            expandIcon.textContent = '⟳';
            expandIcon.classList.add('loading');

            try {
                const result = await fetchPagesInCategory(categoryName);
                const pages = result.pages;
                const hasMore = result.hasMore;

                // Update count label if there are more pages
                if (hasMore) {
                    countLabel.textContent = `(only showing first ${pages.length})`;
                }

                pagesContainer.innerHTML = '';

                if (pages.length === 0) {
                    const noPages = document.createElement('div');
                    noPages.className = 'no-children';
                    noPages.textContent = '(no pages)';
                    pagesContainer.appendChild(noPages);
                } else {
                    pages.forEach(page => {
                        const pageNode = document.createElement('div');
                        pageNode.className = 'tree-node page-item';
                        pageNode.style.marginLeft = '16px';

                        const nodeContent = document.createElement('div');
                        nodeContent.className = 'node-content';

                        const expandArea = document.createElement('div');
                        expandArea.className = 'expand-area';

                        const pageLink = document.createElement('a');
                        pageLink.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`;
                        pageLink.textContent = page.title;
                        pageLink.style.color = 'var(--link-soft)';
                        pageLink.style.textDecoration = 'none';
                        pageLink.style.cursor = 'pointer';
                        pageLink.onmouseover = () => pageLink.style.textDecoration = 'underline';
                        pageLink.onmouseout = () => pageLink.style.textDecoration = 'none';
                        pageLink.onclick = async (e) => {
                            e.preventDefault();
                            await openLink(`https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`);
                        };

                        expandArea.appendChild(pageLink);
                        nodeContent.appendChild(expandArea);

                        // Add parent button (show categories this page belongs to)
                        const parentBtn = document.createElement('button');
                        parentBtn.className = 'parent-btn';
                        parentBtn.textContent = '⬆';
                        parentBtn.title = 'Load categories for this page';
                        parentBtn.onclick = async (e) => {
                            e.stopPropagation();
                            await showCategoriesForPage(pageNode, page.title);
                        };
                        nodeContent.appendChild(parentBtn);

                        pageNode.appendChild(nodeContent);
                        pagesContainer.appendChild(pageNode);
                    });
                }

                nodeDiv.dataset.loaded = 'true';
            } catch (error) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error';
                errorDiv.textContent = `Error loading pages: ${error.message}`;
                pagesContainer.appendChild(errorDiv);
            }

            expandIcon.textContent = '▶';
            expandIcon.classList.remove('loading');
        }

        nodeDiv.dataset.expanded = 'true';
        expandIcon.classList.add('expanded');
        pagesContainer.style.display = 'block';
    };

    return nodeDiv;
}

async function toggleParents(nodeDiv, categoryName) {
    const parentBtn = nodeDiv.querySelector('.parent-btn');

    const originalText = parentBtn.textContent;
    parentBtn.textContent = '⟳';
    parentBtn.disabled = true;

    

    try {
        const parents = await fetchParentCategories(categoryName);

        if (parents.length === 0) {
            alert('This category has no parent categories.');
            return;
        }

        // Load parents in the current sidebar
        const container = document.getElementById('tree-container');
        const input = document.getElementById('category-input');
        const pageInput = document.getElementById('page-input');

        // Do not mirror into input; just clear page input when switching context
        pageInput.value = '';

        // Auto-resize textareas after updating values
        const autoResize = (el) => {
            el.style.height = 'auto';
            el.style.height = el.scrollHeight + 'px';
        };
        autoResize(input);
        autoResize(pageInput);

        container.innerHTML = '';

        parents.forEach(parent => {
            const rootNode = createNodeElement(parent.trim(), 0, true);
            container.appendChild(rootNode);
        });

        // Auto-expand if only one parent category
        if (parents.length === 1) {
            setTimeout(async () => {
                const rootNode = container.querySelector('.tree-node');
                if (rootNode && rootNode.dataset.expanded === 'false') {
                    await toggleNode(rootNode, parents[0].trim());
                }
            }, 100);
        }

    } catch (error) {
        alert(`Error loading parents: ${error.message}`);
    } finally {
        parentBtn.textContent = originalText;
        parentBtn.disabled = false;
    }
}

async function showCategoriesForPage(nodeDiv, pageName) {
    const parentBtn = nodeDiv.querySelector('.parent-btn');

    const originalText = parentBtn.textContent;
    parentBtn.textContent = '⟳';
    parentBtn.disabled = true;

    

    try {
        const categories = await fetchCategoriesForPage(pageName);

        if (categories.length === 0) {
            alert('This page has no categories.');
            return;
        }

        // Load categories in the current sidebar
        const container = document.getElementById('tree-container');
        const input = document.getElementById('category-input');
        const pageInput = document.getElementById('page-input');

        // Do not mirror into input; just clear page input when switching context
        pageInput.value = '';

        // Auto-resize textareas after updating values
        const autoResize = (el) => {
            el.style.height = 'auto';
            el.style.height = el.scrollHeight + 'px';
        };
        autoResize(input);
        autoResize(pageInput);

        container.innerHTML = '';

        categories.forEach(category => {
            const rootNode = createNodeElement(category.trim(), 0, true);
            container.appendChild(rootNode);
        });

        // Auto-expand if only one category
        if (categories.length === 1) {
            setTimeout(async () => {
                const rootNode = container.querySelector('.tree-node');
                if (rootNode && rootNode.dataset.expanded === 'false') {
                    await toggleNode(rootNode, categories[0].trim());
                }
            }, 100);
        }

    } catch (error) {
        alert(`Error loading categories: ${error.message}`);
    } finally {
        parentBtn.textContent = originalText;
        parentBtn.disabled = false;
    }
}

 

 

function preparePathfinderContainer() {
    const container = document.getElementById('pathfinder-container');
    if (!container) return null;

    container.style.display = 'block';
    container.innerHTML = '';
    try { document.body && document.body.setAttribute('data-pathfinder-open', 'true'); } catch (_) {}

    const treeContainer = document.getElementById('tree-container');
    const resizer = document.getElementById('resizer');
    if (resizer) {
        resizer.style.display = 'block';
    }
    if (treeContainer) {
        treeContainer.classList.add('split-mode');
        treeContainer.style.height = '';
    }

    const adjustHeights = () => {
        if (!treeContainer) return;

        const splitView = document.getElementById('split-view');
        const resizerHeight = (resizer && resizer.offsetHeight) || 8;
        const totalHeight = (splitView && (splitView.clientHeight || splitView.offsetHeight)) || 0;

        if (totalHeight <= resizerHeight) {
            treeContainer.style.height = '';
            return;
        }

        const availableHeight = totalHeight - resizerHeight;
        // Respect pathfinder min-height when open
        let pfMin = 100;
        try {
            const cs = window.getComputedStyle(container);
            const mh = parseFloat(cs.minHeight) || 0;
            if (mh > 0) pfMin = mh;
        } catch (_) {}

        const minTree = 100;
        const targetHalf = Math.round(availableHeight / 2);
        const maxTreeAllowed = Math.max(minTree, availableHeight - pfMin);
        const treeHeight = Math.max(minTree, Math.min(targetHalf, maxTreeAllowed));
        treeContainer.style.height = `${treeHeight}px`;
    };

    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(adjustHeights);
    } else {
        setTimeout(adjustHeights, 0);
    }

    // Expose for resize/content changes and only bind once
    window.__adjustSplitHeights = adjustHeights;
    if (!window.__pathfinderResizeHooked) {
        window.addEventListener('resize', () => {
            try {
                if (container.style.display !== 'none' && typeof window.__adjustSplitHeights === 'function') {
                    window.__adjustSplitHeights();
                }
            } catch (_) {}
        });
        window.__pathfinderResizeHooked = true;
    }

    return container;
}

 

async function findPathsToRoot(nodeDiv, categoryName) {
    const pathBtn = nodeDiv.querySelectorAll('.parent-btn')[1];

    const originalText = pathBtn.textContent;
    pathBtn.textContent = '⟳';
    pathBtn.disabled = true;

    const container = preparePathfinderContainer();
    if (!container) {
        console.error('Pathfinder container not found');
        pathBtn.textContent = originalText;
        pathBtn.disabled = false;
        return;
    }

    initializeReversedTreeView(categoryName, container);

    pathBtn.textContent = originalText;
    pathBtn.disabled = false;
}

// Reversed tree view: shows parents nested under children
function initializeReversedTreeView(categoryName, mountEl) {
    mountEl.innerHTML = `
        <div class="pathfinder-header">
            <div><strong>Inverted tree view (child→parents)</strong></div>
            <button id="close-pathfinder" class="close-pathfinder">×</button>
        </div>
        <div id="reversed-tree-content" style="margin-top: 12px;"></div>
    `;

    const closeBtn = mountEl.querySelector('#close-pathfinder');
    const treeContent = mountEl.querySelector('#reversed-tree-content');

    closeBtn.onclick = () => {
        mountEl.style.display = 'none';
        document.getElementById('resizer').style.display = 'none';
        const tc = document.getElementById('tree-container');
        tc.classList.remove('split-mode');
        tc.style.height = '';
        try { document.body && document.body.removeAttribute('data-pathfinder-open'); } catch (_) {}
    };

    // Create the initial node for the starting category
    const rootNode = createReversedTreeNode(categoryName);
    treeContent.appendChild(rootNode);
}

// Create a node element for the reversed tree (parents nested under children)
function createReversedTreeNode(categoryName) {
    const nodeDiv = document.createElement('div');
    nodeDiv.className = 'tree-node';
    nodeDiv.dataset.category = categoryName;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'node-content';

    const expandArea = document.createElement('div');
    expandArea.className = 'expand-area';

    const expandIcon = document.createElement('span');
    expandIcon.className = 'expand-icon';
    expandIcon.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = categoryName;

    expandArea.appendChild(expandIcon);
    expandArea.appendChild(label);
    contentDiv.appendChild(expandArea);

    // Add link to category page
    const link = document.createElement('a');
    link.className = 'category-link';
    link.href = getCategoryUrl(categoryName);
    link.textContent = '🔗';
    link.title = 'Open category page';
    link.onclick = async (e) => {
        // Allow Ctrl+Click, Cmd+Click, Shift+Click for opening in new tab/window
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
            return; // Let browser handle it
        }
        e.preventDefault();
        e.stopPropagation();
        await openLink(getCategoryUrl(categoryName));
    };
    contentDiv.appendChild(link);

    // Add button to show child categories (reset tree with children as roots)
    const childrenBtn = document.createElement('button');
    childrenBtn.className = 'parent-btn';
    childrenBtn.textContent = '⬆';
    childrenBtn.title = 'Load child categories';
    childrenBtn.onclick = async (e) => {
        e.stopPropagation();
        childrenBtn.textContent = '⟳';
        childrenBtn.disabled = true;

        try {
            const children = await fetchSubcategories(categoryName);

            if (children.length === 0) {
                alert('No child categories found');
                return;
            }

            // Get the container and reinitialize with children as new roots
            const container = document.getElementById('pathfinder-container');
            const treeContent = container.querySelector('#reversed-tree-content');
            treeContent.innerHTML = '';

            // Add each child as a root node
            children.forEach(child => {
                const childNode = createReversedTreeNode(child);
                treeContent.appendChild(childNode);
            });
        } catch (error) {
            alert(`Error loading children: ${error.message}`);
        } finally {
            childrenBtn.textContent = '⬆';
            childrenBtn.disabled = false;
        }
    };
    contentDiv.appendChild(childrenBtn);

    // Add button to open in main tree view
    const mainTreeBtn = document.createElement('button');
    mainTreeBtn.className = 'parent-btn';
    mainTreeBtn.textContent = '△';
    mainTreeBtn.title = 'Open in main tree view (parent→children)';
    mainTreeBtn.onclick = async (e) => {
        e.stopPropagation();
        // Load this category in the main tree view
        await loadCategoryByName(categoryName);
    };
    contentDiv.appendChild(mainTreeBtn);

    nodeDiv.appendChild(contentDiv);

    const parentsContainer = document.createElement('div');
    parentsContainer.className = 'children-container';
    parentsContainer.style.display = 'none';
    nodeDiv.appendChild(parentsContainer);

    // Toggle expand/collapse for parents
    expandArea.onclick = async () => {
        const isExpanded = nodeDiv.dataset.expanded === 'true';
        const isLoaded = nodeDiv.dataset.loaded === 'true';

        if (isExpanded) {
            nodeDiv.dataset.expanded = 'false';
            expandIcon.classList.remove('expanded');
            parentsContainer.style.display = 'none';
            return;
        }

        if (!isLoaded) {
            expandIcon.textContent = '⟳';
            expandIcon.classList.add('loading');

            try {
                const parents = await fetchParentCategories(categoryName);

                if (parents.length === 0) {
                    const noParents = document.createElement('div');
                    noParents.className = 'no-children';
                    noParents.textContent = '(no parent categories)';
                    parentsContainer.appendChild(noParents);
                } else {
                    parents.forEach(parent => {
                        const parentNode = createReversedTreeNode(parent);
                        parentsContainer.appendChild(parentNode);
                    });
                }

                nodeDiv.dataset.loaded = 'true';
            } catch (error) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error';
                errorDiv.textContent = `Error loading: ${error.message}`;
                parentsContainer.appendChild(errorDiv);
            }

            expandIcon.textContent = '▶';
            expandIcon.classList.remove('loading');
        }

        nodeDiv.dataset.expanded = 'true';
        expandIcon.classList.add('expanded');
        parentsContainer.style.display = 'block';
    };

    return nodeDiv;
}

// Toggle showing child categories in reversed tree view
 

// container-scoped pathfinder UI for pages - starts from all the page's categories

// container-scoped pathfinder UI

async function toggleNode(nodeDiv, categoryName) {
    const isExpanded = nodeDiv.dataset.expanded === 'true';
    const isLoaded = nodeDiv.dataset.loaded === 'true';
    const expandIcon = nodeDiv.querySelector('.expand-icon');
    const childrenContainer = nodeDiv.querySelector('.children-container');

    if (isExpanded) {
        nodeDiv.dataset.expanded = 'false';
        expandIcon.classList.remove('expanded');
        childrenContainer.style.display = 'none';
        nodeDiv.classList.remove('has-children');
    } else {
        if (!isLoaded) {
            expandIcon.textContent = '⟳';
            expandIcon.classList.add('loading');

            try {
                const subcategories = await fetchSubcategories(categoryName);

                childrenContainer.innerHTML = '';

                // Add "(pages)" special folder at the top if enabled
                if (window.__showPagesFolder !== false) {
                    const pagesFolderNode = createPagesFolderElement(categoryName);
                    childrenContainer.appendChild(pagesFolderNode);
                }

                if (subcategories.length === 0) {
                    const noChildren = document.createElement('div');
                    noChildren.className = 'no-children';
                    noChildren.textContent = '(no subcategories)';
                    childrenContainer.appendChild(noChildren);
                } else {
                    subcategories.forEach(subcat => {
                        const childNode = createNodeElement(subcat);
                        childrenContainer.appendChild(childNode);
                    });
                }

                nodeDiv.dataset.loaded = 'true';
            } catch (error) {
                const errorDiv = document.createElement('div');
                errorDiv.className = 'error';
                errorDiv.textContent = `Error loading: ${error.message}`;
                childrenContainer.appendChild(errorDiv);
            }

            expandIcon.textContent = '▶';
            expandIcon.classList.remove('loading');
        }

        nodeDiv.dataset.expanded = 'true';
        expandIcon.classList.add('expanded');
        childrenContainer.style.display = 'block';
    }
}

function init() {
    // Ensure proper initial state - always show main view
    try { document.body && document.body.setAttribute('data-view', 'main'); } catch (_) {}
    document.getElementById('input-section').style.display = 'block';
    document.getElementById('split-view').style.display = 'flex';
    const currentCatsPanel_hide2 = document.getElementById('current-page-categories-panel');
    if (currentCatsPanel_hide2) {
        const prev = currentCatsPanel_hide2.dataset.prevDisplay;
        currentCatsPanel_hide2.style.display = prev !== undefined ? prev : '';
    }
    

    const container = document.getElementById('tree-container');
    const input = document.getElementById('category-input');
    const pageInput = document.getElementById('page-input');
    const autocompleteDropdown = document.getElementById('autocomplete-dropdown');
    const pageAutocompleteDropdown = document.getElementById('page-autocomplete-dropdown');
    const homeAutocompleteDropdown = document.getElementById('home-autocomplete-dropdown');
    const homeBtn = document.getElementById('home-btn');
    const homeCategoryInput = document.getElementById('home-category-input');
    const currentPageCategoriesPanel = document.getElementById('current-page-categories-panel');
    const currentPageCategoriesContent = document.getElementById('current-page-categories-content');
    
    const decreaseFontBtn = document.getElementById('decrease-font-btn');
    const increaseFontBtn = document.getElementById('increase-font-btn');
    const resetFontBtn = document.getElementById('reset-font-btn');
    const fontSizeDisplay = document.getElementById('font-size-display');
    const themeToggle = document.getElementById('theme-toggle');
    const settingsBtn = document.getElementById('settings-btn');
    const toggleCatsBtn = document.getElementById('toggle-current-cats-btn');
    const showPagesCheckbox = document.getElementById('show-pages-checkbox');

    // Do not mirror current category in the input; keep placeholder unless user types
    input.value = '';

    // Load saved home category
    let homeCategory = 'Articles';
    loadHomeCategory().then(savedHome => {
        homeCategory = savedHome;
        homeCategoryInput.value = savedHome;
    });

    

    // Save home category when changed
    let saveHomeTimeout = null;
    homeCategoryInput.addEventListener('input', () => {
        if (saveHomeTimeout) clearTimeout(saveHomeTimeout);
        saveHomeTimeout = setTimeout(() => {
            const newHome = homeCategoryInput.value.trim() || 'Articles';
            homeCategory = newHome;
            saveHomeCategory(newHome);
        }, 500); // Debounce saves by 500ms
    });

    // Font size functionality
    let currentFontSize = 100; // percentage

    function applyFontSize(size) {
        const scaleFactor = size / 100;
        document.documentElement.style.setProperty('zoom', scaleFactor.toString());
        fontSizeDisplay.textContent = `${size}%`;
        currentFontSize = size;
    }

    async function saveFontSize(size) {
        try {
            await chrome.storage.local.set({ fontSize: size });
        } catch (err) {
            console.error('Error saving font size:', err);
        }
    }

    // Load saved font size
    chrome.storage.local.get('fontSize').then(result => {
        if (result.fontSize) {
            applyFontSize(result.fontSize);
        }
    });

    // Pages folder visibility setting
    function applyPagesFolderVisibility() {
        const enabled = window.__showPagesFolder !== false;
        const tree = document.getElementById('tree-container');
        if (!tree) return;
        const categoryNodes = tree.querySelectorAll('.tree-node');
        categoryNodes.forEach(node => {
            if (node.classList.contains('pages-folder') || node.classList.contains('page-item')) return;
            const catName = node.dataset && node.dataset.category;
            const loaded = node.dataset && node.dataset.loaded === 'true';
            const children = node.querySelector('.children-container');
            if (!children || !loaded) return;
            // Find existing pages folder direct child if any
            let existing = null;
            for (const child of children.children) {
                if (child.classList && child.classList.contains('pages-folder')) { existing = child; break; }
            }
            if (!enabled && existing) {
                existing.remove();
            } else if (enabled && !existing && catName) {
                const pf = createPagesFolderElement(catName);
                children.insertBefore(pf, children.firstChild);
            }
        });
    }

    if (showPagesCheckbox) {
        // Load stored value (default true)
        chrome.storage.local.get('showPagesFolder').then(r => {
            const enabled = Object.prototype.hasOwnProperty.call(r, 'showPagesFolder') ? r.showPagesFolder !== false : true;
            showPagesCheckbox.checked = enabled;
            window.__showPagesFolder = enabled;
            applyPagesFolderVisibility();
        });

        showPagesCheckbox.addEventListener('change', async (e) => {
            const enabled = !!e.target.checked;
            window.__showPagesFolder = enabled;
            try {
                await chrome.storage.local.set({ showPagesFolder: enabled });
            } catch (_) {}
            applyPagesFolderVisibility();
        });
    } else {
        window.__showPagesFolder = true;
    }

    // Theme: tri-state (auto/light/dark) with migration from legacy darkMode
    function applyTheme(mode) {
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const useDark = mode === 'dark' || (mode === 'auto' && prefersDark);
        document.body.classList.toggle('theme-dark', useDark);
    }

    async function initTheme() {
        const stored = await chrome.storage.local.get(['themeMode', 'darkMode']);
        let mode = stored.themeMode;
        if (!mode && typeof stored.darkMode === 'boolean') {
            mode = stored.darkMode ? 'dark' : 'light';
            await chrome.storage.local.set({ themeMode: mode });
        }
        if (!mode) mode = 'auto';
        applyTheme(mode);
        // update segmented buttons
        if (themeToggle) {
            [...themeToggle.querySelectorAll('.seg-btn')].forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }

        if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            mq.addEventListener('change', () => {
                chrome.storage.local.get('themeMode').then(r => {
                    if ((r.themeMode || 'auto') === 'auto') applyTheme('auto');
                });
            });
        }
    }

    if (themeToggle) {
        themeToggle.addEventListener('click', async (e) => {
            const btn = e.target.closest('.seg-btn');
            if (!btn) return;
            const mode = btn.dataset.mode;
            applyTheme(mode);
            [...themeToggle.querySelectorAll('.seg-btn')].forEach(b => b.classList.toggle('active', b === btn));
            try {
                await chrome.storage.local.set({ themeMode: mode });
            } catch (err) {
                console.error('Error saving theme mode:', err);
            }
        });
    }

    initTheme();

    // Link target toggle (current tab vs new tab)
    const linkTargetToggle = document.getElementById('link-target-toggle');

    async function initLinkTarget() {
        const stored = await chrome.storage.local.get('linkTarget');
        const mode = stored.linkTarget || 'current'; // default to current tab
        if (linkTargetToggle) {
            [...linkTargetToggle.querySelectorAll('.seg-btn')].forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }
    }

    if (linkTargetToggle) {
        linkTargetToggle.addEventListener('click', async (e) => {
            const btn = e.target.closest('.seg-btn');
            if (!btn) return;
            const mode = btn.dataset.mode;
            [...linkTargetToggle.querySelectorAll('.seg-btn')].forEach(b => b.classList.toggle('active', b === btn));
            try {
                await chrome.storage.local.set({ linkTarget: mode });
            } catch (err) {
                console.error('Error saving link target mode:', err);
            }
        });
    }

    initLinkTarget();

    // Settings view show/hide
    function showSettingsView() {
        const settingsViewer = document.getElementById('settings-viewer');
        const settingsContent = document.getElementById('settings-content');
        const blocks = document.getElementById('settings-blocks');
        const currentCatsPanel = document.getElementById('current-page-categories-panel');
        if (!settingsViewer || !settingsContent || !blocks) return;
        showOnlyView('settings');
        settingsContent.appendChild(blocks);
        if (currentCatsPanel) {
            currentCatsPanel.dataset.prevDisplay = currentCatsPanel.style.display || '';
            currentCatsPanel.style.display = 'none';
        }
    }

    function hideSettingsView() {
        const settingsViewer = document.getElementById('settings-viewer');
        const homeSlot = document.getElementById('settings-home-slot');
        const blocks = document.getElementById('settings-blocks');
        const currentCatsPanel = document.getElementById('current-page-categories-panel');
        if (!settingsViewer || !homeSlot || !blocks) return;
        homeSlot.appendChild(blocks);
        showOnlyView('main');
        if (currentCatsPanel) {
            const prev = currentCatsPanel.dataset.prevDisplay;
            currentCatsPanel.style.display = prev !== undefined ? prev : '';
        }
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showSettingsView();
        });
    }

    // Top-right toggle for current page categories panel
    async function syncCatsToggleButton() {
        if (!toggleCatsBtn) return;
        try {
            const r = await chrome.storage.local.get('showCurrentPageCategoriesPanel');
            const enabled = Object.prototype.hasOwnProperty.call(r, 'showCurrentPageCategoriesPanel') ? r.showCurrentPageCategoriesPanel !== false : true;
            toggleCatsBtn.setAttribute('aria-pressed', String(enabled));
            toggleCatsBtn.title = enabled ? 'Hide current page categories' : 'Show current page categories';
        } catch (_) {}
    }

    if (toggleCatsBtn) {
        toggleCatsBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                const r = await chrome.storage.local.get('showCurrentPageCategoriesPanel');
                const enabled = Object.prototype.hasOwnProperty.call(r, 'showCurrentPageCategoriesPanel') ? r.showCurrentPageCategoriesPanel !== false : true;
                await chrome.storage.local.set({ showCurrentPageCategoriesPanel: !enabled });
            } catch (_) {}
            await updateCurrentPageCategories();
            await syncCatsToggleButton();
        });
        // initialize visual state
        syncCatsToggleButton();
    }

    const returnFromSettings = document.getElementById('return-to-main-from-settings-link');
    if (returnFromSettings) {
        returnFromSettings.addEventListener('click', (e) => {
            e.preventDefault();
            hideSettingsView();
        });
    }

    // Popout button functionality
    const popoutBtn = document.getElementById('popout-btn');
    if (popoutBtn) {
        popoutBtn.addEventListener('click', async () => {
            try {
                await chrome.windows.create({
                    url: chrome.runtime.getURL('sidepanel.html'),
                    type: 'popup',
                    width: 500,
                    height: 700
                });
            } catch (err) {
                console.error('Error creating popup window:', err);
            }
        });
    }

    decreaseFontBtn.addEventListener('click', () => {
        const newSize = Math.max(50, currentFontSize - 10);
        applyFontSize(newSize);
        saveFontSize(newSize);
    });

    increaseFontBtn.addEventListener('click', () => {
        const newSize = Math.min(200, currentFontSize + 10);
        applyFontSize(newSize);
        saveFontSize(newSize);
    });

    resetFontBtn.addEventListener('click', () => {
        applyFontSize(100);
        saveFontSize(100);
    });

    // Home button functionality
    homeBtn.onclick = async () => {
        const homeToLoad = homeCategoryInput.value.trim() || 'Articles';
        await loadCategoryByName(homeToLoad);
    };

    // Function to update current page categories display
    async function updateCurrentPageCategories() {
        // If not on main view, never show the categories panel
        try {
            if (window.__currentView && window.__currentView !== 'main') {
                currentPageCategoriesPanel.style.display = 'none';
                return;
            }
        } catch (_) {}
        // If user setting disables the panel, hide it
        try {
            const { showCurrentPageCategoriesPanel } = await chrome.storage.local.get('showCurrentPageCategoriesPanel');
            if (showCurrentPageCategoriesPanel === false) {
                currentPageCategoriesPanel.style.display = 'none';
                return;
            }
        } catch (_) {}
        try {
            // If settings viewer is open, hide categories panel
            const isShown = (el) => el && window.getComputedStyle(el).display !== 'none';
            const settingsViewer = document.getElementById('settings-viewer');
            if (isShown(settingsViewer)) {
                currentPageCategoriesPanel.style.display = 'none';
                return;
            }
        } catch (_) {}
        try {
            // Get the current tab
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.url) {
                currentPageCategoriesPanel.style.display = 'none';
                return;
            }

            const url = new URL(tab.url);

            // Check if it's a Wikipedia URL
            if (!url.hostname.includes('wikipedia.org')) {
                currentPageCategoriesPanel.style.display = 'none';
                return;
            }

            const pathname = decodeURIComponent(url.pathname);

            // Check if URL contains "Category:<category_name>" pattern (handles both /wiki/ and index.php?title= formats)
            const categoryInUrlMatch = tab.url.match(/Category:([^#?&/]+)/);

            // Check if it's an index.php?title= format URL
            const titleParam = url.searchParams.get('title');

            // Show for both article pages and category pages
            if (pathname.includes('/wiki/') || categoryInUrlMatch || titleParam) {
                let categories;
                let pageName;

                if (categoryInUrlMatch) {
                    // Use the category name as the page name
                    pageName = 'Category:' + decodeURIComponent(categoryInUrlMatch[1]);
                    categories = await fetchCategoriesForPage(pageName);
                } else if (titleParam) {
                    // Use the title parameter from index.php URLs
                    pageName = titleParam;
                    // Check if it's a category page in the title param
                    if (pageName.startsWith('Category:')) {
                        const categoryName = pageName.replace('Category:', '');
                        categories = await fetchParentCategories(categoryName);
                    } else {
                        categories = await fetchCategoriesForPage(pageName);
                    }
                } else if (pathname.includes('/wiki/Category:')) {
                    // Check if it's a category page
                    const categoryName = pathname.split('/wiki/Category:')[1].split('#')[0].split('?')[0];
                    // Fetch parent categories for the category
                    categories = await fetchParentCategories(categoryName);
                } else {
                    // Regular article page
                    pageName = pathname.split('/wiki/')[1].split('#')[0].split('?')[0];
                    // Fetch categories for the page
                    categories = await fetchCategoriesForPage(pageName);
                }

                if (categories && categories.length > 0) {
                    // Create clickable links for each category
                    currentPageCategoriesContent.innerHTML = '';
                    categories.forEach((cat, idx) => {
                        // Wrap each category + buttons as a single unit
                        const unit = document.createElement('span');
                        unit.className = 'current-category-unit';
                        const link = document.createElement('a');
                        link.href = `https://en.wikipedia.org/wiki/Category:${encodeURIComponent(cat.replace(/ /g, '_'))}`;
                        link.textContent = cat;
                        link.title = 'Open category page';
                        // Let CSS control decoration; keep color if needed
                        link.style.cssText = 'color: var(--link-soft);';
                        // No hover underline effects
                        link.addEventListener('click', async (e) => {
                            // Open in new tab/window on modifier-clicks
                            if (e.ctrlKey || e.metaKey || e.shiftKey) {
                                e.preventDefault();
                                openInNewTab(link.href);
                                return;
                            }
                            e.preventDefault();
                            try {
                                await openLink(link.href);
                            } catch (err) {
                                console.error('Error navigating to category page:', err);
                            }
                        });

                        unit.appendChild(link);
                        // Keep buttons immediately adjacent to text (no extra gap)

                        // Buttons group (kept together, never wraps)
                        const btnGroup = document.createElement('span');
                        btnGroup.className = 'current-category-btns';

                        // Add button to open in main tree view
                        const mainTreeBtn = document.createElement('button');
                        mainTreeBtn.className = 'parent-btn';
                        mainTreeBtn.textContent = '△';
                        mainTreeBtn.title = 'Open in main tree view (parent→children)';
                        mainTreeBtn.addEventListener('click', async (e) => {
                            e.preventDefault();
                            await loadCategoryByName(cat);
                        });
                        btnGroup.appendChild(mainTreeBtn);

                        // Add button to open in inverted tree view
                        const invertedTreeBtn = document.createElement('button');
                        invertedTreeBtn.className = 'parent-btn';
                        invertedTreeBtn.textContent = '▽';
                        invertedTreeBtn.title = 'Open in inverted tree view (child→parents)';
                        invertedTreeBtn.addEventListener('click', async (e) => {
                            e.preventDefault();
                            const container = preparePathfinderContainer();
                            if (container) {
                                initializeReversedTreeView(cat, container);
                            }
                        });
                        btnGroup.appendChild(invertedTreeBtn);

                        unit.appendChild(btnGroup);

                        currentPageCategoriesContent.appendChild(unit);

                        // Add comma separator between units (not after last)
                        if (idx < categories.length - 1) {
                            const sep = document.createElement('span');
                            sep.className = 'current-category-sep';
                            sep.textContent = ', ';
                            currentPageCategoriesContent.appendChild(sep);
                        }
                    });
                    currentPageCategoriesPanel.style.display = 'block';
                    // Units are unbreakable; no width adjustment needed
                    // If pathfinder is open, re-balance heights now that top panel height changed
                    try {
                        if (typeof window.__adjustSplitHeights === 'function') {
                            requestAnimationFrame(window.__adjustSplitHeights);
                        }
                    } catch (_) {}
                } else {
                    currentPageCategoriesContent.textContent = '(no categories found on current page)';
                    currentPageCategoriesPanel.style.display = 'block';
                    try {
                        if (typeof window.__adjustSplitHeights === 'function') {
                            requestAnimationFrame(window.__adjustSplitHeights);
                        }
                    } catch (_) {}
                }
            } else {
                currentPageCategoriesPanel.style.display = 'none';
                try {
                    if (typeof window.__adjustSplitHeights === 'function') {
                        requestAnimationFrame(window.__adjustSplitHeights);
                    }
                } catch (_) {}
            }
        } catch (error) {
            console.error('Error fetching current page categories:', error);
            currentPageCategoriesPanel.style.display = 'none';
            try {
                if (typeof window.__adjustSplitHeights === 'function') {
                    requestAnimationFrame(window.__adjustSplitHeights);
                }
            } catch (_) {}
        }
    }

    // Listen for tab changes to update categories
    chrome.tabs.onActivated.addListener(async () => {
        await updateCurrentPageCategories();
    });

    chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
        if (changeInfo.status === 'complete') {
            await updateCurrentPageCategories();
        }
    });

    // Expose so other views can refresh visibility safely
    window.updateCurrentPageCategories = updateCurrentPageCategories;

    // Initialize on load
    updateCurrentPageCategories();
    // No resize adjustment needed for unbreakable units

    
    

 

    // Auto-resize textarea function
    function autoResizeTextarea(textarea) {
        const min = 20; // keep inputs compact when empty
        textarea.style.height = 'auto';
        const val = (textarea.value || '').trim();
        if (!val) {
            textarea.style.height = min + 'px';
            return;
        }
        const h = Math.max(min, textarea.scrollHeight);
        textarea.style.height = h + 'px';
    }

    // Initialize textarea auto-resize
    autoResizeTextarea(input);
    autoResizeTextarea(pageInput);

    // Add auto-resize listeners
    input.addEventListener('input', () => autoResizeTextarea(input));
    pageInput.addEventListener('input', () => autoResizeTextarea(pageInput));

    // Autocomplete state for category input
    let autocompleteTimeout = null;
    let selectedIndex = -1;
    let currentSuggestions = [];

    // Autocomplete state for page input
    let pageAutocompleteTimeout = null;
    let pageSelectedIndex = -1;
    let pageCurrentSuggestions = [];

    // Autocomplete state for home category input
    let homeAutocompleteTimeout = null;
    let homeSelectedIndex = -1;
    let homeCurrentSuggestions = [];

    // Autocomplete functionality
    function hideAutocomplete() {
        autocompleteDropdown.classList.remove('show');
        autocompleteDropdown.innerHTML = '';
        selectedIndex = -1;
        currentSuggestions = [];
    }

    function showAutocomplete(suggestions) {
        currentSuggestions = suggestions;
        autocompleteDropdown.innerHTML = '';

        if (suggestions.length === 0) {
            hideAutocomplete();
            return;
        }

        suggestions.forEach((suggestion, index) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = suggestion;
            item.addEventListener('click', () => {
                input.value = suggestion;
                autoResizeTextarea(input);
                hideAutocomplete();
                // Immediately submit selection
                loadCategory();
            });
            autocompleteDropdown.appendChild(item);
        });

        autocompleteDropdown.classList.add('show');
        selectedIndex = -1;
    }

    function updateSelectedItem() {
        const items = autocompleteDropdown.querySelectorAll('.autocomplete-item');
        items.forEach((item, index) => {
            if (index === selectedIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    input.addEventListener('input', (e) => {
        const value = e.target.value.trim();

        // Clear previous timeout
        if (autocompleteTimeout) {
            clearTimeout(autocompleteTimeout);
        }

        // Hide dropdown if input is empty
        if (value.length === 0) {
            hideAutocomplete();
            return;
        }

        // Show loading state
        autocompleteDropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
        autocompleteDropdown.classList.add('show');

        // Debounce the search
        autocompleteTimeout = setTimeout(async () => {
            const suggestions = await searchCategories(value, 15);
            showAutocomplete(suggestions);
        }, 300);
    });

    input.addEventListener('keydown', (e) => {
        if (!autocompleteDropdown.classList.contains('show')) {
            if (e.key === 'Enter') {
                e.preventDefault();
                loadCategory();
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, currentSuggestions.length - 1);
                updateSelectedItem();
                break;
            case 'ArrowUp':
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, -1);
                updateSelectedItem();
                break;
            case 'Enter':
                e.preventDefault();
                if (selectedIndex >= 0 && selectedIndex < currentSuggestions.length) {
                    input.value = currentSuggestions[selectedIndex];
                    autoResizeTextarea(input);
                    hideAutocomplete();
                    loadCategory();
                } else {
                    hideAutocomplete();
                    loadCategory();
                }
                break;
            case 'Escape':
                e.preventDefault();
                hideAutocomplete();
                break;
        }
    });

    // Hide autocomplete when clicking outside
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !autocompleteDropdown.contains(e.target)) {
            hideAutocomplete();
        }
        if (!pageInput.contains(e.target) && !pageAutocompleteDropdown.contains(e.target)) {
            hidePageAutocomplete();
        }
        if (homeCategoryInput && homeAutocompleteDropdown &&
            !homeCategoryInput.contains(e.target) && !homeAutocompleteDropdown.contains(e.target)) {
            hideHomeAutocomplete();
        }
    });

    // Page autocomplete functionality
    function hidePageAutocomplete() {
        pageAutocompleteDropdown.classList.remove('show');
        pageAutocompleteDropdown.innerHTML = '';
        pageSelectedIndex = -1;
        pageCurrentSuggestions = [];
    }

    function showPageAutocomplete(suggestions) {
        pageCurrentSuggestions = suggestions;
        pageAutocompleteDropdown.innerHTML = '';

        if (suggestions.length === 0) {
            hidePageAutocomplete();
            return;
        }

        suggestions.forEach((suggestion) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = suggestion;
            item.addEventListener('click', () => {
                pageInput.value = suggestion;
                autoResizeTextarea(pageInput);
                hidePageAutocomplete();
                // Immediately submit selection
                loadPage();
            });
            pageAutocompleteDropdown.appendChild(item);
        });

        pageAutocompleteDropdown.classList.add('show');
        pageSelectedIndex = -1;
    }

    function updatePageSelectedItem() {
        const items = pageAutocompleteDropdown.querySelectorAll('.autocomplete-item');
        items.forEach((item, index) => {
            if (index === pageSelectedIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    pageInput.addEventListener('input', (e) => {
        const value = e.target.value.trim();

        if (pageAutocompleteTimeout) {
            clearTimeout(pageAutocompleteTimeout);
        }

        if (value.length === 0) {
            hidePageAutocomplete();
            return;
        }

        pageAutocompleteDropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
        pageAutocompleteDropdown.classList.add('show');

        pageAutocompleteTimeout = setTimeout(async () => {
            const suggestions = await searchPages(value, 15);
            showPageAutocomplete(suggestions);
        }, 300);
    });

    pageInput.addEventListener('keydown', (e) => {
        if (!pageAutocompleteDropdown.classList.contains('show')) {
            if (e.key === 'Enter') {
                e.preventDefault();
                loadPage();
            }
            return;
        }

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                pageSelectedIndex = Math.min(pageSelectedIndex + 1, pageCurrentSuggestions.length - 1);
                updatePageSelectedItem();
                break;
            case 'ArrowUp':
                e.preventDefault();
                pageSelectedIndex = Math.max(pageSelectedIndex - 1, -1);
                updatePageSelectedItem();
                break;
            case 'Enter':
                e.preventDefault();
                if (pageSelectedIndex >= 0 && pageSelectedIndex < pageCurrentSuggestions.length) {
                    pageInput.value = pageCurrentSuggestions[pageSelectedIndex];
                    autoResizeTextarea(pageInput);
                    hidePageAutocomplete();
                    loadPage();
                } else {
                    hidePageAutocomplete();
                    loadPage();
                }
                break;
            case 'Escape':
                e.preventDefault();
                hidePageAutocomplete();
                break;
        }
    });

    // Home category autocomplete functionality
    function hideHomeAutocomplete() {
        if (!homeAutocompleteDropdown) return;
        homeAutocompleteDropdown.classList.remove('show');
        homeAutocompleteDropdown.innerHTML = '';
        homeSelectedIndex = -1;
        homeCurrentSuggestions = [];
    }

    function showHomeAutocomplete(suggestions) {
        if (!homeAutocompleteDropdown) return;
        homeCurrentSuggestions = suggestions;
        homeAutocompleteDropdown.innerHTML = '';

        if (suggestions.length === 0) {
            hideHomeAutocomplete();
            return;
        }

        suggestions.forEach((suggestion) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item';
            item.textContent = suggestion;
            item.addEventListener('click', () => {
                homeCategoryInput.value = suggestion;
                hideHomeAutocomplete();
                homeCategoryInput.focus();
            });
            homeAutocompleteDropdown.appendChild(item);
        });

        homeAutocompleteDropdown.classList.add('show');
        homeSelectedIndex = -1;
    }

    function updateHomeSelectedItem() {
        if (!homeAutocompleteDropdown) return;
        const items = homeAutocompleteDropdown.querySelectorAll('.autocomplete-item');
        items.forEach((item, index) => {
            if (index === homeSelectedIndex) {
                item.classList.add('selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('selected');
            }
        });
    }

    if (homeCategoryInput && homeAutocompleteDropdown) {
        homeCategoryInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();

            if (homeAutocompleteTimeout) {
                clearTimeout(homeAutocompleteTimeout);
            }

            if (value.length === 0) {
                hideHomeAutocomplete();
                return;
            }

            homeAutocompleteDropdown.innerHTML = '<div class="autocomplete-loading">Searching...</div>';
            homeAutocompleteDropdown.classList.add('show');

            homeAutocompleteTimeout = setTimeout(async () => {
                const suggestions = await searchCategories(value, 15);
                showHomeAutocomplete(suggestions);
            }, 300);
        });

        homeCategoryInput.addEventListener('keydown', (e) => {
            if (!homeAutocompleteDropdown.classList.contains('show')) return;
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    homeSelectedIndex = Math.min(homeSelectedIndex + 1, homeCurrentSuggestions.length - 1);
                    updateHomeSelectedItem();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    homeSelectedIndex = Math.max(homeSelectedIndex - 1, -1);
                    updateHomeSelectedItem();
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (homeSelectedIndex >= 0 && homeSelectedIndex < homeCurrentSuggestions.length) {
                        homeCategoryInput.value = homeCurrentSuggestions[homeSelectedIndex];
                        hideHomeAutocomplete();
                    } else {
                        hideHomeAutocomplete();
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    hideHomeAutocomplete();
                    break;
            }
        });
    }

    window.loadCategoryByName = async function(categoryName) {
        const category = categoryName.trim().replace('Category:', '');
        if (!category) return;

        

        try {
            const exists = await categoryExists(category);
            if (!exists) {
                alert(`Category "${category}" does not exist on Wikipedia.`);
                return;
            }

            // Keep inputs untouched; only clear page field
            pageInput.value = '';
            autoResizeTextarea(pageInput);

            container.innerHTML = '';

            const rootNode = createNodeElement(category, 0, true);
            container.appendChild(rootNode);

            // Auto-expand the single category
            setTimeout(async () => {
                if (rootNode && rootNode.dataset.expanded === 'false') {
                    await toggleNode(rootNode, category);
                }
            }, 100);
        } catch (err) {
            alert(`Error: ${err.message}`);
        } finally {
            // no-op
        }
    };

    async function loadCategory() {
        await loadCategoryByName(input.value);
        // Clear field back to placeholder and shrink
        input.value = '';
        autoResizeTextarea(input);
    }

    async function loadPage() {
        const page = pageInput.value.trim();
        if (!page) return;
        
        

        try {
            const categories = await fetchCategoriesForPage(page);

            if (categories.length === 0) {
                alert(`No categories found for page "${page}". The page may not exist or have no categories.`);
                return;
            }

            // Do not mirror into the search input
            container.innerHTML = '';

            // Display all categories as root nodes
            categories.forEach(category => {
                const rootNode = createNodeElement(category.trim(), 0, true);
                container.appendChild(rootNode);
            });

            // Auto-expand if only one category
            if (categories.length === 1) {
                setTimeout(async () => {
                    const rootNode = container.querySelector('.tree-node');
                    if (rootNode && rootNode.dataset.expanded === 'false') {
                        await toggleNode(rootNode, categories[0].trim());
                    }
                }, 100);
            }
        } catch (err) {
            alert(`Error: ${err.message}`);
        } finally {
            // Clear field back to placeholder and shrink
            pageInput.value = '';
            autoResizeTextarea(pageInput);
        }
    }


    input.onkeypress = (e) => {
        if (e.key === 'Enter' && !autocompleteDropdown.classList.contains('show')) {
            e.preventDefault();
            loadCategory();
        }
    };

    // Initialize with home category (do not mirror into input)
    (async () => {
        const savedHome = await loadHomeCategory();
        await loadCategoryByName(savedHome);
        
    })();

 
}

init();

// Resizer functionality
(function initResizer() {
    const resizer = document.getElementById('resizer');
    const treeContainer = document.getElementById('tree-container');
    const splitView = document.getElementById('split-view');

    let isResizing = false;
    let startY = 0;
    let startTreeHeight = 0;

    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startY = e.clientY;
        startTreeHeight = treeContainer.offsetHeight;
        resizer.classList.add('active');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        const delta = e.clientY - startY;
        const newTreeHeight = startTreeHeight + delta;
        const minTree = 100; // minimum for the top tree
        let pfMin = 100;     // minimum for the bottom pathfinder (when open)
        try {
            const pf = document.getElementById('pathfinder-container');
            if (pf && window.getComputedStyle) {
                const mh = parseFloat(window.getComputedStyle(pf).minHeight) || 0;
                if (mh > 0) pfMin = mh;
            }
        } catch (_) {}
        const maxHeight = splitView.offsetHeight - pfMin - 8; // 8px for resizer

        if (newTreeHeight >= minTree && newTreeHeight <= maxHeight) {
            treeContainer.style.height = newTreeHeight + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            resizer.classList.remove('active');
        }
    });
})();
