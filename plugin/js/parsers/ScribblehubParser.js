"use strict";

parserFactory.register("scribblehub.com", () => new ScribblehubParser());

class ScribblehubFetchErrorHandler extends FetchErrorHandler {
    constructor() {
        super();
        // seconds to wait before each retry of a network-level failure
        // (note: order is reversed, delays are popped)
        this.networkRetryDelay = [60, 30, 15];
    }

    // Cloudflare has permanently 403-blocked the client, so retrying (or
    // asking the user to retry) just risks deepening the block.  Halt now.
    // (must override onResponseError: getAutomaticRetryBehaviourForStatus is
    // static and invoked base-qualified, an override would never run)
    onResponseError(url, wrapOptions, response, errorMessage) {
        if (httpResponse.status === 403) {
            let failError;
            if (errorMessage) {
                failError = new Error(errorMessage);
            } else {
                failError = new Error(this.makeFailMessage(response.url, response.status));
            }
            return Promise.reject(failError);
        }
        return super.onResponseError(url, wrapOptions, response, errorMessage);
    }

    // network-level failures (connection reset, DNS, timeout) reject from
    // fetch() with TypeError; errors raised before fetching (e.g. blocked
    // sites) are plain Errors and must not be retried
    onFetchError(url, error) {
        if ((error instanceof TypeError) && (0 < this.networkRetryDelay.length)) {
            let delay = this.networkRetryDelay.pop() * 1000;
            return util.sleep(delay)
                .then(() => HttpClient.wrapFetch(url, { errorHandler: this }));
        }
        return super.onFetchError(url, error);
    }
}

class ScribblehubParser extends Parser {
    constructor() {
        super();
        this.minimumThrottle = 7500;
    }

    async getChapterUrls(dom, chapterUrlsUI) {
        this.tocURL = dom.baseURI;
        let baseUrl = dom.baseURI;
        let nextTocIndex = 1;
        let numChapters = parseInt(dom.querySelector("span.cnt_toc").textContent);
        let nextTocPageUrl = function(_dom, chapters, lastFetch) {
            // site has bug, sometimes, won't return chapters, so 
            // don't loop forever when this happens
            return ((chapters.length < numChapters) && (0 < lastFetch.length))
                ? `${baseUrl}?toc=${++nextTocIndex}`
                : null;
        };

        // ScribbleHub's Cloudflare protection permanently 403-blocks the client
        // if a ToC page request arrives without a Referer, so fetch the pages
        // sequentially, sending the previous ToC page as the Referer each time.
        let chapters = ScribblehubParser.getChapterUrlsFromTocPage(dom);
        chapterUrlsUI.showTocProgress(chapters);
        let url = nextTocPageUrl(dom, chapters, chapters);
        let referer = dom.baseURI;
        while (url != null) {
            await this.rateLimitDelay();
            await HttpClient.setDeclarativeNetRequestRules(
                ScribblehubParser.makeFetchRules(referer)
            );
            dom = (await HttpClient.wrapFetch(url,
                { errorHandler: new ScribblehubFetchErrorHandler() }
            )).responseXML;
            referer = url;
            let partialList = ScribblehubParser.getChapterUrlsFromTocPage(dom);
            chapterUrlsUI.showTocProgress(partialList);
            chapters = chapters.concat(partialList);
            url = nextTocPageUrl(dom, chapters, partialList);
        }
        return chapters.reverse();
    }

    static getChapterUrlsFromTocPage(dom) {
        return [...dom.querySelectorAll("a.toc_a")]
            .map(a => util.hyperLinkToChapter(a));
    }

    static makeFetchRules(referer) {
        return [
            {
                id: 1,
                priority: 1,
                action: {
                    type: "modifyHeaders",
                    requestHeaders: [
                        {
                            header: "referer",
                            operation: "set",
                            value: referer,
                        },
                        {
                            header: "sec-fetch-dest",
                            operation: "set",
                            value: "document",
                        },
                        {
                            header: "sec-fetch-mode",
                            operation: "set",
                            value: "navigate",
                        },
                        {
                            header: "sec-fetch-site",
                            operation: "set",
                            value: "same-origin",
                        },
                    ],
                },
                condition: {
                    urlFilter: "*://www.scribblehub.com/*",
                },
            },
        ];
    }

    async fetchChapter(url) {
        await HttpClient.setDeclarativeNetRequestRules(
            ScribblehubParser.makeFetchRules(this.tocURL)
        );

        return (await HttpClient.wrapFetch(url,
            { errorHandler: new ScribblehubFetchErrorHandler() }
        )).responseXML;
    }

    findContent(dom) {
        return dom.querySelector("div.fic_row, div#chp_raw");
    }

    populateUIImpl() {
        document.getElementById("removeAuthorNotesRow").hidden = false;
    }

    extractTitleImpl(dom) {
        return dom.querySelector("div.fic_title");
    }

    extractAuthor(dom) {
        let author = dom.querySelector("span.auth_name_fic");
        return (author === null) ? super.extractAuthor(dom) : author.textContent;
    }
    
    extractSubject(dom) {
        let selector = "[property='genre']";
        if (!document.getElementById("lesstagsCheckbox").checked) {
            selector += ", .stag";
        }
        let tags = [...dom.querySelectorAll(selector)];
        return tags.map(e => e.textContent.trim()).join(", ");
    }

    extractDescription(dom) {
        return this.extractDescriptionInternal(dom)?.innerText?.trim();
    }
    // unwrap the description from the readmore that you may get on mobile
    extractDescriptionInternal(dom) {
        let desc = dom.querySelector(".wi_fic_desc");
        if (desc != null) {
            desc.querySelectorAll(".dots, .morelink").forEach(e => e.remove());
            desc.querySelectorAll(".testhide").forEach(e => e.replaceWith(...e.childNodes));
        }

        return desc;
    }

    findChapterTitle(dom) {
        return dom.querySelector("div.chapter-title").textContent;
    }

    findCoverImageUrl(dom) {
        return util.getFirstImgSrc(dom, "div.fic_image");
    }

    preprocessRawDom(webPageDom) {
        let content = this.findContent(webPageDom);

        this.tagAuthorNotesBySelector(content, ".wi_authornotes, .wi_news");

        // spoilers
        for (let element of content.querySelectorAll(".sp-wrap")) {
            element.querySelector(".sp-body>.spdiv")?.remove();

            let details = webPageDom.createElement("details");
            let summary = webPageDom.createElement("summary");
            summary.append(...element.querySelector(".sp-head").childNodes);
            details.append(summary);
            details.append(...element.querySelector(".sp-body").childNodes);

            element.replaceWith(details);
        }

        // anouncements
        for (let element of content.querySelectorAll(".wi_news_title")) {
            element.setAttribute("style", "font-weight: bold");
            element.querySelector(".fa-exclamation-triangle").replaceWith("⚠");
        }

        // author notes
        for (let element of content.querySelectorAll(".p-avatar-wrap")) {
            element.remove();
        }

    }

    getInformationEpubItemChildNodes(dom) {
        function cleanTag(tag, index, array) {
            let out = tag.ownerDocument.createElement("a");
            out.setAttribute("href", tag.getAttribute("href"));
            out.innerText = tag.innerText;
            return index < array.length -1 ? [out, ", "] : [out];
        }

        let info = [];

        info.push(dom.createElement("div").innerHTML = "<p><b>Synopsis</b></p>");
        let synopsis = this.extractDescriptionInternal(dom);
        if (synopsis) {
            info.push(...synopsis.childNodes);
        }

        let genre = dom.querySelectorAll(".wi_fic_genre a.fic_genre");
        if (genre.length > 0) {
            info.push(dom.createElement("div").innerHTML = "<p><b>Genre</b></p>");
            info.push(...[...genre].flatMap(cleanTag));
        }

        let fandom = dom.querySelectorAll(".wi_fic_genre a.stag");
        if (fandom.length > 0) {
            info.push(dom.createElement("div").innerHTML = "<p><b>Fandom</b></p>");
            info.push(...[...fandom].flatMap(cleanTag));
        }

        let tags = dom.querySelectorAll(".wi_fic_showtags a.stag");
        if (tags.length > 0) {
            info.push(dom.createElement("div").innerHTML = "<p><b>Tags</b></p>");
            info.push(...[...tags].flatMap(cleanTag));
        }
  
        return info;
    }
}
