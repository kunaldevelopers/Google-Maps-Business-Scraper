import express from "express";
import puppeteer from "puppeteer";
import PuppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as cheerio from "cheerio";
import xlsx from "xlsx";
import mongoose from "mongoose";
import readline from "readline";
import chalk from "chalk";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import winston from "winston";
import pLimit from "p-limit";

// Setup Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "scraper.log" }),
  ],
});

// Initialize Puppeteer with StealthPlugin
PuppeteerExtra.use(StealthPlugin());
const puppeteerExtra = PuppeteerExtra;

// Set up API interception capability
const setupAPIInterception = async (page) => {
  // Store for API responses
  page.googleMapAPIResponses = [];

  // XHR interception - Chrome extension style
  await page.evaluateOnNewDocument(() => {
    // Intercept XMLHttpRequest like the Chrome extension does
    const XHR = XMLHttpRequest.prototype;
    const open = XHR.open;
    const send = XHR.send;

    XHR.open = function (method, url) {
      this.url = url;
      return open.apply(this, arguments);
    };

    XHR.send = function () {
      this.addEventListener("load", function () {
        if (
          this.url &&
          (this.url.includes("/maps/search") ||
            this.url.includes("/maps/place"))
        ) {
          try {
            // Create hidden element to store response data
            if (!document.querySelector("#searchAPIResponseData")) {
              const element = document.createElement("div");
              element.id = "searchAPIResponseData";
              element.innerText = this.responseText;
              element.style.height = 0;
              element.style.overflow = "hidden";
              document.body.appendChild(element);
            } else {
              document.querySelector("#searchAPIResponseData").innerText =
                this.responseText;
            }

            console.log(
              "Intercepted Maps API data with length: " +
                this.responseText.length
            );
          } catch (err) {
            console.error("Error in XHR interception:", err);
          }
        }
      });

      return send.apply(this, arguments);
    };
  });

  // Also observe network responses
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/maps/search") || url.includes("/maps/place")) {
      try {
        const contentType = response.headers()["content-type"] || "";
        if (contentType.includes("json") || contentType.includes("text")) {
          const text = await response.text();
          if (text && text.length > 100) {
            page.googleMapAPIResponses.push({
              url,
              data: text,
            });
          }
        }
      } catch (e) {
        // Some responses can't be read as text
      }
    }
  });
};

// MongoDB Setup
let mongoConnected = false;
let DataModel;

const connectToMongoDB = async () => {
  try {
    await mongoose.connect("mongodb://localhost/google_maps_scraper");
    logger.info(chalk.green("✓ Connected to MongoDB"));

    const dataSchema = new mongoose.Schema({
      name: { type: String, required: true },
      phone: { type: String, default: null },
      rating: { type: Number, default: 0 },
      ratingCount: { type: String, default: "0" },
      address: { type: String, default: null },
      category: { type: String, default: null },
      website: { type: String, default: null },
      hoursOfOperation: { type: String, default: null },
      photos: { type: [String], default: [] },
      scrapedAt: { type: Date, default: Date.now },
    });

    DataModel = mongoose.model("Data", dataSchema);
    mongoConnected = true;
    return true;
  } catch (err) {
    logger.warn(chalk.yellow(`MongoDB connection failed: ${err.message}`));
    return false;
  }
};

// Anti-Detection Setup
const setupAntiDetection = async (page) => {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setExtraHTTPHeaders({
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
  });
};

// Check for CAPTCHA
const checkForCaptcha = async (page) => {
  const captchaSelector =
    'form[action*="/sorry/index"], div[class*="captcha"], img[src*="/sorry/image"]';
  const hasCaptcha = await page.evaluate((selector) => {
    return !!document.querySelector(selector);
  }, captchaSelector);
  if (hasCaptcha) {
    logger.error(chalk.red("CAPTCHA detected. Saving screenshot..."));
    await page.screenshot({ path: "captcha_screenshot.png" });
    throw new Error("CAPTCHA detected");
  }
  return false;
};

// Scrolling Function - Enhanced to load many more listings (up to 120+)
const autoScrollGoogleMaps = async (page, maxResults) => {
  logger.info(
    chalk.cyan(
      "Starting aggressive scrolling to load all available listings..."
    )
  );

  const scrollResult = await page.evaluate(async (maxResults) => {
    return new Promise((resolve) => {
      // Track the previous number of results to detect when new ones stop loading
      let previousResultCount = 0;
      let noChangeCount = 0;
      let totalScrolls = 0;
      const maxScrollAttempts = 100; // Increased for more thorough scrolling

      // Enhanced scroll pane detection
      const getScrollPane = () => {
        const selectors = [
          'div[role="feed"]',
          'div[role="main"] div[aria-label*="Results for"]',
          'div[class*="section-layout"] div[class*="section-scrollbox"]',
          'div[class*="m6QErb"]', // Updated selector
          'div[class*="section-scrollbox"]',
          'div[data-value="search"]',
          ".section-scrollbox",
        ];

        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element) return element;
        }
        return null;
      };

      // Enhanced listing counting with multiple selectors
      const countListings = () => {
        const selectors = [
          'div[role="article"]',
          'div[class*="Nv2PK"]',
          'a[href*="maps/place"]',
          'div[class*="hfpxzc"]',
          'div[jsaction*="mouseover:pane"]',
          "div[data-result-index]",
          "div[data-value]",
          "div.section-result",
          'div[aria-label*="result"]',
          ".section-result-content",
          ".section-result",
        ];

        const allElements = new Set();
        selectors.forEach((selector) => {
          document
            .querySelectorAll(selector)
            .forEach((el) => allElements.add(el));
        });

        return allElements.size;
      };

      // Find the scroll container
      const scrollPane = getScrollPane();
      if (!scrollPane) {
        console.log("Could not find scroll pane element");
        return resolve({
          resultsCount: 0,
          message: "Scroll container not found",
        });
      }

      console.log(
        `Starting aggressive scrolling process to load all listings (up to ${maxResults})`
      );

      // Enhanced scroll function with multiple techniques
      const performScroll = () => {
        try {
          const scrollPane = getScrollPane();
          if (!scrollPane) return false;

          // Multiple scrolling techniques for better loading
          const currentScrollTop = scrollPane.scrollTop;
          const scrollHeight = scrollPane.scrollHeight;

          // Method 1: Scroll to bottom
          scrollPane.scrollTop = scrollHeight;

          // Method 2: Scroll by pixels
          scrollPane.scrollBy(0, 1000);

          // Method 3: Wheel event simulation
          const wheelEvent = new WheelEvent("wheel", {
            deltaY: 1000,
            deltaX: 0,
            bubbles: true,
            cancelable: true,
          });
          scrollPane.dispatchEvent(wheelEvent);

          // Method 4: Mouse wheel simulation
          const mouseWheelEvent = new Event("mousewheel", { bubbles: true });
          mouseWheelEvent.wheelDelta = -1000;
          scrollPane.dispatchEvent(mouseWheelEvent);

          // Method 5: Keyboard simulation (PageDown)
          const keyEvent = new KeyboardEvent("keydown", {
            key: "PageDown",
            code: "PageDown",
            bubbles: true,
          });
          scrollPane.dispatchEvent(keyEvent);

          return scrollPane.scrollTop !== currentScrollTop;
        } catch (e) {
          console.error("Error in performScroll:", e);
          return false;
        }
      };

      // Enhanced "Show more" button handling
      const setupShowMoreHandlers = () => {
        const buttonTexts = [
          "Show more",
          "Load more",
          "Next",
          "More results",
          "See more",
          "More",
          "Continue",
          "Load additional",
        ];

        const buttons = Array.from(
          document.querySelectorAll(
            "button, div[role='button'], span[role='button']"
          )
        ).filter((btn) => {
          const text = btn.textContent.toLowerCase();
          return buttonTexts.some((buttonText) =>
            text.includes(buttonText.toLowerCase())
          );
        });

        let clicked = false;
        buttons.forEach((btn) => {
          try {
            if (btn.offsetParent !== null) {
              // Check if visible
              btn.click();
              console.log(`Clicked button: ${btn.textContent.trim()}`);
              clicked = true;
            }
          } catch (e) {
            // Ignore errors from clicking
          }
        });

        return clicked;
      };

      // Enhanced loading detection
      const waitForLoading = () => {
        return new Promise((resolve) => {
          let checkCount = 0;
          const maxChecks = 10;

          const checkLoading = () => {
            checkCount++;

            // Look for loading indicators
            const loadingIndicators = document.querySelectorAll(
              '[data-value="loading"], .loading, [aria-label*="Loading"], [aria-label*="loading"]'
            );

            if (loadingIndicators.length === 0 || checkCount >= maxChecks) {
              resolve();
            } else {
              setTimeout(checkLoading, 200);
            }
          };

          setTimeout(checkLoading, 100);
        });
      };

      // Main scroll interval with enhanced logic
      const scrollInterval = setInterval(async () => {
        const currentResults = countListings();
        console.log(
          `Scroll attempt ${
            totalScrolls + 1
          }: found ${currentResults} results (target: ${maxResults})`
        );

        // Enhanced scrolling with multiple attempts per iteration
        let scrollSuccess = false;
        for (let attempt = 0; attempt < 6; attempt++) {
          if (performScroll()) {
            scrollSuccess = true;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          // Vary scroll positions
          const scrollPane = getScrollPane();
          if (scrollPane) {
            scrollPane.scrollBy(0, 200 * (attempt + 1));
          }
        }

        // Try to click "Show more" buttons
        const clickedButton = setupShowMoreHandlers();
        if (clickedButton) {
          // Wait a bit longer if we clicked a button
          await waitForLoading();
        }

        totalScrolls++;

        // Check if we've reached our target
        if (currentResults >= maxResults) {
          clearInterval(scrollInterval);
          console.log(
            `✓ Reached target: ${currentResults} listings found (target: ${maxResults})`
          );
          return resolve({
            resultsCount: currentResults,
            message: `Found ${currentResults} listings (reached target)`,
          });
        }

        // Enhanced failure detection
        if (!scrollSuccess && !clickedButton) {
          noChangeCount++;
          if (noChangeCount >= 3) {
            clearInterval(scrollInterval);
            console.log(
              `Scroll container no longer responsive, found ${currentResults} listings`
            );
            return resolve({
              resultsCount: currentResults,
              message: `Found ${currentResults} listings (scroll container unresponsive)`,
            });
          }
        }

        // Enhanced stagnation detection
        if (currentResults === previousResultCount) {
          noChangeCount++;

          // Be more patient - Google Maps loads in batches
          if (noChangeCount >= 12) {
            // Final aggressive scroll attempt
            console.log("Performing final aggressive scroll...");
            for (let i = 0; i < 10; i++) {
              performScroll();
              setupShowMoreHandlers();
              await new Promise((resolve) => setTimeout(resolve, 200));
            }

            // Final count after aggressive scrolling
            setTimeout(() => {
              const finalResults = countListings();
              clearInterval(scrollInterval);
              console.log(
                `✓ Scrolling complete: ${finalResults} listings found (no more results loading)`
              );
              return resolve({
                resultsCount: finalResults,
                message: `Found ${finalResults} listings (no more results loading)`,
              });
            }, 3000);
            return;
          }
        } else {
          // Reset the counter if we got new results
          noChangeCount = 0;
          previousResultCount = currentResults;
        }

        // Safety check to prevent infinite scrolling
        if (totalScrolls >= maxScrollAttempts) {
          clearInterval(scrollInterval);
          console.log(
            `✓ Scrolling stopped after ${maxScrollAttempts} attempts, found ${currentResults} listings`
          );
          return resolve({
            resultsCount: currentResults,
            message: `Found ${currentResults} listings (max attempts reached)`,
          });
        }
      }, 800); // Slightly slower for better stability
    });
  }, maxResults);

  logger.info(
    chalk.green(
      `Scrolling complete: ${scrollResult?.message || "Unknown result"}`
    )
  );
  return scrollResult;
};

// Extraction Functions
const extractName = ($) => {
  const selectors = ["h1", 'div[class*="fontHeadline"]'];
  for (const selector of selectors) {
    const text = $(selector).text().trim();
    if (text) return text;
  }
  return "";
};

const extractPhone = async ($, page) => {
  // First try to extract from DOM using existing selectors
  const selectors = [
    'a[href^="tel:"]',
    '[data-item-id="phone"]',
    'div:contains("Phone")',
  ];

  let phoneNumber = null;

  // Try DOM extraction first
  for (const selector of selectors) {
    const element = $(selector);
    if (element.length) {
      const text =
        element.attr("href")?.replace("tel:", "") || element.text().trim();
      const cleaned = text.replace(/[^\d+]/g, "");
      if (cleaned.length >= 10) {
        phoneNumber = cleaned;
        break;
      }
    }
  }

  // If DOM extraction failed, try to intercept network requests for phone data
  if (!phoneNumber) {
    try {
      // Advanced technique - pull from API response (inspired by Chrome extension)
      phoneNumber = await page.evaluate(() => {
        // Look for the phone number in Google's structured data
        try {
          // Check for data in global _pageData variable
          const appState = window._pageData && window._pageData.state;
          if (appState) {
            const entities = appState.entities || {};
            for (const key in entities) {
              const entity = entities[key];
              if (entity && entity.phone) {
                return entity.phone.replace(/[^\d+]/g, "");
              }
            }
          }

          // Check for data in script tags
          const scripts = document.querySelectorAll(
            'script[type="application/ld+json"]'
          );
          for (const script of scripts) {
            try {
              const data = JSON.parse(script.textContent);
              if (data && data.telephone) {
                return data.telephone.replace(/[^\d+]/g, "");
              }
            } catch (e) {
              // Skip parsing errors
            }
          }

          // Try to find phone in raw JSON response via regex
          const phoneRegex = /"phoneNumber"\s*:\s*"([^"]+)"/;
          const scripts2 = document.querySelectorAll("script");
          for (const script of scripts2) {
            const match = script.textContent.match(phoneRegex);
            if (match && match[1]) {
              return match[1].replace(/[^\d+]/g, "");
            }
          }
        } catch (err) {
          console.error("Error extracting phone from API data:", err);
        }
        return null;
      });
    } catch (err) {
      logger.warn(
        chalk.yellow(`Advanced phone extraction failed: ${err.message}`)
      );
    }
  }

  return phoneNumber;
};

const extractRating = ($) => {
  const selectors = [
    'span[aria-label*="star rating"]',
    'div[class*="fontDisplay"]',
  ];
  for (const selector of selectors) {
    const text = $(selector).text().trim();
    const rating = parseFloat(text);
    if (!isNaN(rating) && rating >= 0 && rating <= 5) return rating;
  }
  return 0;
};

const extractRatingCount = ($) => {
  const selectors = ['span[aria-label*="reviews"]', 'div:contains("reviews")'];
  for (const selector of selectors) {
    const text = $(selector).text().trim();
    const match = text.match(/\d+/);
    if (match) return match[0];
  }
  return "0";
};

const extractAddress = ($) => {
  const selectors = ['div:contains("Address")', 'div[class*="fontBodyMedium"]'];
  for (const selector of selectors) {
    const text = $(selector).text().trim();
    if (text && !text.includes("Directions")) return text;
  }
  return null;
};

const extractCategory = ($) => {
  const selectors = [
    'span:contains("Category")',
    'button[class*="fontBodyMedium"]',
  ];
  for (const selector of selectors) {
    const text = $(selector).text().trim();
    if (text) return text.split("·")[0].trim();
  }
  return null;
};

const extractWebsite = ($) => {
  const link = $('a[href^="http"]:not([href*="google.com"])').attr("href");
  return link || null;
};

const extractHoursOfOperation = ($) => {
  const selectors = ['div:contains("Hours")', 'table[aria-label*="hours"]'];
  for (const selector of selectors) {
    const text = $(selector)
      .text()
      .replace(/Hours|Open/gi, "")
      .trim();
    if (text) return text;
  }
  return null;
};

const extractPhotos = async (page) => {
  try {
    const photos = await page.evaluate(() => {
      const images = Array.from(
        document.querySelectorAll('img[src*="lh5.googleusercontent.com"]')
      );
      return images
        .map((img) => img.src)
        .filter((src) => src.includes("photo"));
    });
    return photos.slice(0, 3);
  } catch (err) {
    logger.warn(chalk.yellow(`Photo extraction failed: ${err.message}`));
    return [];
  }
};

// Extract email from website content - enhanced with Chrome extension technique
const extractEmailFromWebsite = async (browser, website, businessName) => {
  if (!website) return null;

  try {
    logger.info(chalk.blue(`Extracting email from website: ${website}`));

    const page = await browser.newPage();
    await setupAntiDetection(page);
    await page.setDefaultNavigationTimeout(30000);

    try {
      await page.goto(website, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Extract emails using multiple methods
      const emails = await page.evaluate((businessName) => {
        const results = [];

        // Method 1: Direct DOM search using regex
        const emailRegex =
          /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
        const bodyText = document.body.innerText;
        const emailMatches = bodyText.match(emailRegex) || [];

        // Add unique emails only
        const uniqueEmails = new Set();
        emailMatches.forEach((email) => {
          // Basic email validation
          if (email.length > 5 && email.includes("@") && email.includes(".")) {
            uniqueEmails.add(email.toLowerCase());
          }
        });

        uniqueEmails.forEach((email) => results.push(email));

        // Method 2: Look for visible elements with mailto links
        const mailtoLinks = document.querySelectorAll('a[href^="mailto:"]');
        mailtoLinks.forEach((link) => {
          const email = link.href.replace("mailto:", "").split("?")[0].trim();
          if (email && !uniqueEmails.has(email.toLowerCase())) {
            uniqueEmails.add(email.toLowerCase());
            results.push(email);
          }
        });

        // Method 3: Check contact page if available
        const contactLinks = Array.from(document.querySelectorAll("a")).filter(
          (a) =>
            a.textContent.toLowerCase().includes("contact") ||
            a.href.toLowerCase().includes("contact")
        );

        // If there's a contact page and we didn't find emails, we'll need to visit it
        if (contactLinks.length > 0 && uniqueEmails.size === 0) {
          const contactHrefs = contactLinks
            .map((a) => a.href)
            .filter((href) => href && href !== "#");
          if (contactHrefs.length > 0) {
            return { emails: results, contactUrl: contactHrefs[0] };
          }
        }

        // Filter out likely invalid emails
        return {
          emails: results.filter((email) => {
            // Skip emails that are probably not business emails
            const lowEmail = email.toLowerCase();
            const invalidPatterns = [
              "example.com",
              "yourdomain",
              "domain.com",
              "@example",
              "@test",
            ];
            return !invalidPatterns.some((pattern) =>
              lowEmail.includes(pattern)
            );
          }),
          contactUrl: null,
        };
      }, businessName);

      // Visit contact page if we didn't find emails on the main page
      if (emails.contactUrl && emails.emails.length === 0) {
        try {
          await page.goto(emails.contactUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
          });

          // Try to extract emails from contact page
          const contactPageEmails = await page.evaluate(() => {
            const emailRegex =
              /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/gi;
            const bodyText = document.body.innerText;
            const emailMatches = bodyText.match(emailRegex) || [];

            const uniqueEmails = new Set();
            emailMatches.forEach((email) => {
              if (
                email.length > 5 &&
                email.includes("@") &&
                email.includes(".")
              ) {
                uniqueEmails.add(email.toLowerCase());
              }
            });

            return Array.from(uniqueEmails);
          });

          // Add contact page emails to our results
          if (contactPageEmails.length > 0) {
            emails.emails = [
              ...new Set([...emails.emails, ...contactPageEmails]),
            ];
          }
        } catch (contactErr) {
          logger.warn(
            chalk.yellow(`Error accessing contact page: ${contactErr.message}`)
          );
        }
      }

      await page.close();

      // Return the first email found or null
      return emails.emails.length > 0 ? emails.emails[0] : null;
    } catch (err) {
      logger.warn(chalk.yellow(`Email extraction failed: ${err.message}`));
      await page.close();
      return null;
    }
  } catch (err) {
    logger.error(
      chalk.red(`Browser error during email extraction: ${err.message}`)
    );
    return null;
  }
};

// Parse data from intercepted Google Maps API responses
const parseGoogleMapsAPIData = async (page) => {
  try {
    // First check if we have any responses captured by our interceptor
    if (
      !page.googleMapAPIResponses ||
      page.googleMapAPIResponses.length === 0
    ) {
      // Check if the special element exists that might contain API data (from XHR interception)
      const hasAPIData = await page.evaluate(() => {
        return !!document.querySelector("#searchAPIResponseData");
      });

      if (!hasAPIData) {
        logger.info(chalk.yellow("No API responses captured to parse"));
        return null;
      }

      // Get data from the special element (similar to Chrome extension approach)
      const apiData = await page.evaluate(() => {
        const element = document.querySelector("#searchAPIResponseData");
        if (!element) return null;

        const responseText = element.innerText;
        if (!responseText || responseText.length < 50) return null;

        // Log that we found data in the special element
        console.log(
          "Found API data in searchAPIResponseData element:",
          responseText.substring(0, 100) + "..."
        );

        try {
          // Try to parse the Google Maps data format similar to Chrome extension
          // First check for the ")]}'," format that Google often uses
          let cleanData = responseText;
          if (cleanData.startsWith(")]}'")) {
            cleanData = cleanData.substring(4);
          }

          // Try to parse as JSON
          const parsedData = JSON.parse(cleanData);

          // Process for businesses - similar to what the Chrome extension's readBusinessCollection does
          let businessesData = null;

          // Check several possible paths where business data might be found
          if (parsedData) {
            // Check path used by Chrome extension first
            if (parsedData.d) {
              try {
                const innerJson = JSON.parse(parsedData.d.substr(4));
                if (innerJson && innerJson[64]) {
                  businessesData = innerJson[64];
                }
              } catch (e) {
                console.error("Error parsing inner JSON:", e);
              }
            }

            // Try other common paths
            if (!businessesData) {
              const pathsToCheck = [
                parsedData[64],
                parsedData[0]?.[1],
                parsedData[0]?.[0]?.[1],
                parsedData[1],
                parsedData[0],
              ];

              for (const path of pathsToCheck) {
                if (Array.isArray(path) && path.length > 0) {
                  businessesData = path;
                  break;
                }
              }
            }
          }

          // Process businesses data similar to readBusinessCollection in Chrome extension
          if (businessesData && Array.isArray(businessesData)) {
            const extractedBusinesses = [];
            const processedNames = new Set();

            for (let i = 0; i < businessesData.length; i++) {
              let businessItem = businessesData[i];

              // Handle different data formats similar to Chrome extension
              if (
                businessItem.length === 15 &&
                Array.isArray(businessItem[14])
              ) {
                businessItem = businessItem[14];
              } else if (
                businessItem.length === 2 &&
                Array.isArray(businessItem[1])
              ) {
                businessItem = businessItem[1];
              }

              if (!businessItem) continue;

              // Extract data using the indices from the Chrome extension logic
              const name = businessItem[11]
                ? businessItem[11]
                    .replace(/\,/g, " ")
                    .replace(/\'/g, " ")
                    .replace(/\"/g, " ")
                : "";
              const fullAddress = businessItem[39] || "";

              // Skip if we've already processed this business
              if (!name || processedNames.has(name + fullAddress)) continue;
              processedNames.add(name + fullAddress);

              // Create business object with extracted data
              const business = {
                name: name,
                fullAddress: fullAddress,
                email: "",
                phone: "",
                image: "",
                website: null,
                domain: null,
                category: "",
                hours: {},
                uuid: businessItem[9] || "",
              };

              // Extract additional data using indices from Chrome extension
              if (businessItem[7]) {
                business.website = businessItem[7][0];
                business.domain = businessItem[7][1];
              }

              if (
                businessItem[178] &&
                businessItem[178][0] &&
                businessItem[178][0][0]
              ) {
                business.phone = businessItem[178][0][0];
              }

              if (businessItem[157]) {
                business.image = businessItem[157];
                business.imageUrl = businessItem[157];
              }

              // Extract rating and reviews
              if (businessItem[4] && businessItem[4][7]) {
                business.rating = businessItem[4][7];
              }

              if (businessItem[4] && businessItem[4][8]) {
                business.reviewCount = businessItem[4][8];
              }

              // Extract category
              if (businessItem[13] && businessItem[13][0]) {
                business.category = businessItem[13][0];
              }

              // Extract hours - exactly as Chrome extension does
              if (businessItem[34] && businessItem[34][1]) {
                const hoursData = businessItem[34][1];
                if (hoursData && hoursData.length > 0) {
                  for (let h = 0; h < hoursData.length; h++) {
                    const dayEntry = hoursData[h];
                    const day = dayEntry[0];
                    const hours =
                      dayEntry[1] && dayEntry[1][0] ? dayEntry[1][0] : "";

                    if (day === "Sunday") business.hours.sunday = hours;
                    else if (day === "Monday") business.hours.monday = hours;
                    else if (day === "Tuesday") business.hours.tuesday = hours;
                    else if (day === "Wednesday")
                      business.hours.wednesday = hours;
                    else if (day === "Thursday")
                      business.hours.thursday = hours;
                    else if (day === "Friday") business.hours.friday = hours;
                    else if (day === "Saturday")
                      business.hours.saturday = hours;
                  }
                }
              }

              extractedBusinesses.push(business);
            }

            return extractedBusinesses;
          }
        } catch (err) {
          console.error("Error processing API data:", err);
          return null;
        }

        return null;
      });

      if (apiData && apiData.length > 0) {
        logger.info(
          chalk.green(
            `Successfully extracted ${apiData.length} businesses from API response in DOM`
          )
        );
        return apiData;
      }

      return null;
    }

    // If we have responses from our direct interception, process those as well
    logger.info(
      chalk.blue(
        `Parsing ${page.googleMapAPIResponses.length} captured API responses`
      )
    );

    // Process each response - similar approach as above but using our captured responses
    const extractedBusinesses = [];
    const processedNames = new Set();

    for (const response of page.googleMapAPIResponses) {
      try {
        let data = response.data;
        if (!data || data.length < 50) continue;

        // Clean up response data - this is what the Chrome extension does
        if (data.startsWith(")]}'")) {
          data = data.substring(4);
        }

        try {
          const parsed = JSON.parse(data);

          // Try different paths where business data might be located
          let businessesData = null;

          if (parsed.d) {
            try {
              const innerJson = JSON.parse(parsed.d.substr(4));
              if (innerJson && innerJson[64]) {
                businessesData = innerJson[64];
              }
            } catch (e) {
              // Skip parsing errors
            }
          }

          if (!businessesData) {
            const pathsToCheck = [
              parsed[64],
              parsed[0]?.[1],
              parsed[0]?.[0]?.[1],
              parsed[1],
              parsed[0],
            ];

            for (const path of pathsToCheck) {
              if (Array.isArray(path) && path.length > 0) {
                businessesData = path;
                break;
              }
            }
          }

          // Process businesses
          if (businessesData && Array.isArray(businessesData)) {
            for (let i = 0; i < businessesData.length; i++) {
              let businessItem = businessesData[i];

              if (
                businessItem.length === 15 &&
                Array.isArray(businessItem[14])
              ) {
                businessItem = businessItem[14];
              } else if (
                businessItem.length === 2 &&
                Array.isArray(businessItem[1])
              ) {
                businessItem = businessItem[1];
              }

              if (!businessItem) continue;

              const name = businessItem[11]
                ? businessItem[11]
                    .replace(/\,/g, " ")
                    .replace(/\'/g, " ")
                    .replace(/\"/g, " ")
                : "";
              const fullAddress = businessItem[39] || "";

              if (!name || processedNames.has(name + fullAddress)) continue;
              processedNames.add(name + fullAddress);

              const business = {
                name: name,
                fullAddress: fullAddress,
                email: "",
                phone: "",
                imageUrl: "",
                website: null,
                domain: null,
                category: "",
                hours: {},
                uuid: businessItem[9] || "",
              };

              // Extract fields same as above
              if (businessItem[7]) {
                business.website = businessItem[7][0];
                business.domain = businessItem[7][1];
              }

              if (
                businessItem[178] &&
                businessItem[178][0] &&
                businessItem[178][0][0]
              ) {
                business.phone = businessItem[178][0][0];
              }

              if (businessItem[157]) {
                business.imageUrl = businessItem[157];
              }

              if (businessItem[4] && businessItem[4][7]) {
                business.rating = businessItem[4][7];
              }

              if (businessItem[4] && businessItem[4][8]) {
                business.reviewCount = businessItem[4][8];
              }

              if (businessItem[13] && businessItem[13][0]) {
                business.category = businessItem[13][0];
              }

              // Extract hours
              if (businessItem[34] && businessItem[34][1]) {
                const hoursData = businessItem[34][1];
                if (hoursData && hoursData.length > 0) {
                  for (let h = 0; h < hoursData.length; h++) {
                    const dayEntry = hoursData[h];
                    const day = dayEntry[0];
                    const hours =
                      dayEntry[1] && dayEntry[1][0] ? dayEntry[1][0] : "";

                    if (day === "Sunday") business.hours.sunday = hours;
                    else if (day === "Monday") business.hours.monday = hours;
                    else if (day === "Tuesday") business.hours.tuesday = hours;
                    else if (day === "Wednesday")
                      business.hours.wednesday = hours;
                    else if (day === "Thursday")
                      business.hours.thursday = hours;
                    else if (day === "Friday") business.hours.friday = hours;
                    else if (day === "Saturday")
                      business.hours.saturday = hours;
                  }
                }
              }

              extractedBusinesses.push(business);
            }
          }
        } catch (parseErr) {
          // Skip parsing errors for this response
        }
      } catch (err) {
        // Skip this response
      }
    }

    if (extractedBusinesses.length > 0) {
      logger.info(
        chalk.green(
          `Successfully extracted ${extractedBusinesses.length} businesses from API responses`
        )
      );
      return extractedBusinesses;
    }

    logger.info(chalk.yellow("No businesses found in API responses"));
    return null;
  } catch (err) {
    logger.warn(chalk.yellow(`API data parsing error: ${err.message}`));
    return null;
  }
};

// Function to enhance API data with details from individual place pages
const enhanceAPIDataWithDetailPages = async (browser, apiData, options) => {
  logger.info(
    chalk.cyan(
      `Enhancing ${apiData.length} API-extracted businesses with detail page data`
    )
  );

  // Limit parallel processing to prevent getting blocked
  const detailParallelLimit = Math.min(2, options.parallelLimit || 2);
  const limit = pLimit(detailParallelLimit);

  const enhancedData = [];

  for (let i = 0; i < apiData.length; i++) {
    const item = apiData[i];

    try {
      // Skip enhancement if we already have complete data
      if (item.name && item.phone && item.website && item.fullAddress) {
        logger.info(
          chalk.green(`Item ${i + 1} already has complete data: ${item.name}`)
        );

        // Convert to standard format
        enhancedData.push({
          name: item.name || "",
          phone: item.phone || "",
          rating: item.rating || 0,
          ratingCount: item.reviewCount ? String(item.reviewCount) : "0",
          address: item.fullAddress || "",
          category: item.category || "",
          website: item.website || "",
          hoursOfOperation:
            Object.entries(item.hours || {})
              .map(([day, hours]) => `${day}: ${hours}`)
              .join("; ") || "",
          photos: [item.imageUrl].filter(Boolean),
        });
        continue;
      }

      // Construct Google Maps place URL
      const placeName = encodeURIComponent(item.name);
      const placeUrl = item.uuid
        ? `https://www.google.com/maps/place/?q=place_id:${item.uuid}`
        : `https://www.google.com/maps/search/${placeName}`;

      logger.info(chalk.blue(`Enhancing data for item ${i + 1}: ${item.name}`));

      // Add a delay between requests to avoid detection
      await sleep(getRandomDelay(3000, 6000));

      const detailPage = await browser.newPage();
      await setupAntiDetection(detailPage);
      await setupAPIInterception(detailPage);
      await detailPage.setDefaultNavigationTimeout(60000);

      try {
        await detailPage.goto(placeUrl, {
          waitUntil: "networkidle2",
          timeout: 45000,
        });
      } catch (navErr) {
        logger.warn(
          chalk.yellow(
            `Detail page navigation issue: ${navErr.message}. Trying alternative method...`
          )
        );
        await detailPage.goto(placeUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45000,
        });
      }

      await checkForCaptcha(detailPage);

      // Extract any missing data using DOM methods as a fallback
      const content = await detailPage.content();
      const $detail = cheerio.load(content);

      // Phone is especially important to try to extract if missing
      if (!item.phone) {
        item.phone = await extractPhone($detail, detailPage);
      }

      // Website is another important field to enhance
      if (!item.website) {
        item.website = extractWebsite($detail);
      }

      // Only extract photos if needed and not already available
      if (options.includePhotos && !item.imageUrl) {
        const photoUrls = await extractPhotos(detailPage);
        item.imageUrl = photoUrls[0] || "";
      }

      // Get any hours not from the API
      if (Object.keys(item.hours || {}).length === 0) {
        const hoursText = extractHoursOfOperation($detail);
        if (hoursText) {
          // Parse hours text into the hours object
          const dayMapping = {
            monday: "monday",
            tuesday: "tuesday",
            wednesday: "wednesday",
            thursday: "thursday",
            friday: "friday",
            saturday: "saturday",
            sunday: "sunday",
          };

          const hourLines = hoursText.split(";").map((s) => s.trim());
          item.hours = item.hours || {};

          hourLines.forEach((line) => {
            const parts = line.split(":");
            if (parts.length >= 2) {
              const day = parts[0].toLowerCase().trim();
              const hours = parts.slice(1).join(":").trim();

              if (dayMapping[day]) {
                item.hours[dayMapping[day]] = hours;
              }
            }
          });
        }
      }

      await detailPage.close();

      // Convert to standard format and add to results
      enhancedData.push({
        name: item.name || "",
        phone: item.phone || "",
        rating: item.rating || 0,
        ratingCount: item.reviewCount ? String(item.reviewCount) : "0",
        address: item.fullAddress || "",
        category: item.category || "",
        website: item.website || "",
        hoursOfOperation:
          Object.entries(item.hours || {})
            .map(([day, hours]) => `${day}: ${hours}`)
            .join("; ") || "",
        photos: [item.imageUrl].filter(Boolean),
      });
    } catch (err) {
      logger.warn(
        chalk.yellow(`Error enhancing item ${i + 1}: ${err.message}`)
      );

      // Return what we have even if enhancement failed
      enhancedData.push({
        name: item.name || "",
        phone: item.phone || "",
        rating: item.rating || 0,
        ratingCount: item.reviewCount ? String(item.reviewCount) : "0",
        address: item.fullAddress || "",
        category: item.category || "",
        website: item.website || "",
        hoursOfOperation:
          Object.entries(item.hours || {})
            .map(([day, hours]) => `${day}: ${hours}`)
            .join("; ") || "",
        photos: [item.imageUrl].filter(Boolean),
      });
    }
  }

  return enhancedData;
};

// Utility Functions
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getRandomDelay = (min, max) =>
  Math.floor(Math.random() * (max - min) + min);

const retry = async (fn, retries, delay) => {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    logger.warn(chalk.yellow(`Retrying, waiting ${delay / 1000}s...`));
    await sleep(delay);
    return retry(fn, retries - 1, delay * 1.5);
  }
};

const validateData = (item) => {
  const errors = [];
  if (!item.name) errors.push("Name is required");
  if (item.rating < 0 || item.rating > 5) errors.push("Invalid rating");
  if (item.ratingCount && isNaN(parseInt(item.ratingCount)))
    errors.push("Invalid rating count");
  return errors;
};

const saveToExcel = (data, filePath) => {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(chalk.gray(`Created directory: ${dir}`));
    }

    // Pre-process data to ensure it doesn't exceed Excel cell limits (32,767 characters)
    const processedData = data.map((item) => {
      // Deep clone the item to avoid modifying the original
      const processedItem = { ...item };

      // Handle photos array
      if (
        Array.isArray(processedItem.photos) &&
        processedItem.photos.length > 0
      ) {
        // For Excel, just keep the first photo URL to avoid cell limit issues
        const firstPhotoUrl = processedItem.photos[0];
        processedItem.photos = firstPhotoUrl
          ? firstPhotoUrl.length > 250
            ? firstPhotoUrl.substring(0, 250) + "..."
            : firstPhotoUrl
          : "";
      } else {
        processedItem.photos = "";
      }

      // Excel has a 32,767 character limit per cell - ensure we don't exceed it
      Object.keys(processedItem).forEach((key) => {
        if (typeof processedItem[key] === "string") {
          if (processedItem[key].length > 32000) {
            processedItem[key] = processedItem[key].substring(0, 32000) + "...";
          }
        }
      });

      // Make sure hours of operation isn't too long
      if (
        processedItem.hoursOfOperation &&
        processedItem.hoursOfOperation.length > 1000
      ) {
        processedItem.hoursOfOperation =
          processedItem.hoursOfOperation.substring(0, 1000) + "...";
      }

      return processedItem;
    });

    // Create or update the Excel file
    let wb = fs.existsSync(filePath)
      ? xlsx.readFile(filePath)
      : xlsx.utils.book_new();

    // Start with a fresh sheet to avoid appending to existing data
    const ws = xlsx.utils.json_to_sheet(processedData);

    // Set the sheet name
    const sheetName = "GoogleMapsData";
    wb.SheetNames = [sheetName];
    wb.Sheets[sheetName] = ws;

    // Write the Excel file
    xlsx.writeFile(wb, filePath, { compression: true });

    // Create CSV file separately for better compatibility
    const csvFilePath = filePath.replace(".xlsx", ".csv");

    // For CSV, we need to be even more careful with field lengths
    const csvData = processedData.map((row) => {
      const csvRow = { ...row };
      // Keep CSV rows shorter for maximum compatibility
      Object.keys(csvRow).forEach((key) => {
        if (typeof csvRow[key] === "string" && csvRow[key].length > 500) {
          csvRow[key] = csvRow[key].substring(0, 500) + "...";
        }
      });
      return csvRow;
    });

    const csvWb = xlsx.utils.book_new();
    const csvWs = xlsx.utils.json_to_sheet(csvData);
    xlsx.utils.book_append_sheet(csvWb, csvWs, sheetName);
    xlsx.writeFile(csvWb, csvFilePath, { bookType: "csv" });

    logger.info(chalk.green(`Saved to ${filePath} and ${csvFilePath}`));
    return processedData.length;
  } catch (err) {
    logger.error(chalk.red(`Excel save error: ${err.message}`));

    // Create a simple emergency CSV backup if Excel fails
    try {
      const emergencyFilePath = filePath.replace(
        ".xlsx",
        "_emergency_backup.csv"
      );

      // Create extremely simplified CSV with minimal data
      const safeData = data.map((item) => ({
        name: item.name ? item.name.substring(0, 200) : "",
        phone: item.phone ? item.phone.substring(0, 20) : "",
        rating: item.rating || 0,
        address: item.address ? item.address.substring(0, 200) : "",
        website: item.website ? item.website.substring(0, 200) : "",
      }));

      const csvContent = [
        Object.keys(safeData[0] || {}).join(","),
        ...safeData.map((row) =>
          Object.values(row)
            .map((val) =>
              typeof val === "string" ? `"${val.replace(/"/g, '""')}"` : val
            )
            .join(",")
        ),
      ].join("\n");

      fs.writeFileSync(emergencyFilePath, csvContent);
      logger.info(
        chalk.green(`Created emergency backup at ${emergencyFilePath}`)
      );
    } catch (backupErr) {
      logger.error(chalk.red(`Emergency backup failed: ${backupErr.message}`));
    }
    return 0;
  }
};

// Sanitize Query for Filename
const sanitizeQuery = (query) => {
  let cleanQuery = query;
  if (query.startsWith("https://www.google.com/maps/search/")) {
    const match = query.match(/search\/([^\/]+)/);
    cleanQuery = match ? decodeURIComponent(match[1].split(",")[0]) : "search";
  }
  return cleanQuery
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 50);
};

// Main Scraping Logic
const scrapePage = async (url, options) => {
  let browser = null;
  try {
    logger.info(chalk.cyan(`Scraping Google Maps: ${url}`));
    browser = await puppeteerExtra.launch({
      headless: options.headless,
      defaultViewport: null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--start-maximized",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-dev-shm-usage",
        "--js-flags=--max-old-space-size=8192", // Increase memory limit
      ],
      timeout: 60000,
    });

    const page = await browser.newPage();
    await setupAntiDetection(page);
    await setupAPIInterception(page);

    // Speed optimization: Set lower timeouts for faster processing
    await page.setDefaultNavigationTimeout(45000);
    await page.setDefaultTimeout(30000);
    await sleep(getRandomDelay(500, 1000)); // Reduced delay

    logger.info(chalk.gray("Loading Google Maps..."));
    try {
      // Faster loading with reduced wait time
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Only wait for network idle if needed
      await page
        .waitForSelector('div[role="feed"], div[role="article"]', {
          timeout: 15000,
        })
        .catch(() =>
          logger.warn(
            chalk.yellow("Feed selector not found, continuing anyway...")
          )
        );
    } catch (navigationErr) {
      logger.warn(
        chalk.yellow(
          `Navigation issue: ${navigationErr.message}. Continuing with partial load...`
        )
      );
    }
    await checkForCaptcha(page);

    // Advanced aggressive scrolling to load ALL listings (up to max)
    logger.info(
      chalk.cyan(
        `Starting aggressive scrolling to load up to ${options.maxResults} listings...`
      )
    );
    const scrollResult = await autoScrollGoogleMaps(page, options.maxResults);
    logger.info(
      chalk.green(
        `Scrolling complete: found ${scrollResult?.resultsCount || 0} listings`
      )
    );

    // Optimized: Shorter delay after scrolling
    await sleep(getRandomDelay(1000, 1500));

    // Make the API responses available in the browser context for parsing
    await page.evaluate((responseData) => {
      window.googleMapAPIResponses = responseData;
    }, page.googleMapAPIResponses || []);

    // Try to extract all data directly from the search page first - IMPROVED EXTRACTION
    logger.info(chalk.blue("Extracting bulk data from search page..."));

    const bulkExtractedData = await page.evaluate(() => {
      try {
        const results = [];
        const processedNames = new Set();

        // Enhanced listing selectors - Updated for current Google Maps structure
        const listingSelectors = [
          'div[role="article"]',
          'div[class*="Nv2PK"]',
          'a[href*="/maps/place"]',
          'div[class*="hfpxzc"]',
          'div[jsaction*="mouseover:pane"]',
          "div[data-result-index]",
          "div[data-value]",
          "div.section-result",
          'div[aria-label*="result"]',
          ".section-result-content",
          ".section-result",
        ];

        // Get all potential listings using multiple selectors
        const allListings = new Set();
        listingSelectors.forEach((selector) => {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el) => allListings.add(el));
        });

        console.log(`Found ${allListings.size} potential listing elements`);

        for (const listing of allListings) {
          try {
            // Multiple name selectors to catch different layouts
            const nameSelectors = [
              'div[class*="fontHeadlineSmall"]',
              "h3",
              ".fontHeadlineSmall",
              'div[class*="qBF1Pd"]', // Updated selector
              'span[class*="fontHeadlineSmall"]',
              "[data-value] > div > div:first-child",
              ".section-result-title",
              'a[href*="/maps/place"] > div',
              'div[role="button"] > div > div:first-child',
            ];

            let nameElement = null;
            let name = "";

            for (const selector of nameSelectors) {
              nameElement = listing.querySelector(selector);
              if (nameElement) {
                name = nameElement.textContent.trim();
                if (name && name.length > 1) break;
              }
            }

            // Skip if no valid name found or already processed
            if (!name || name.length < 2 || processedNames.has(name)) continue;
            processedNames.add(name);

            // Create listing data with default values
            const item = {
              name: name,
              address: "",
              category: "",
              rating: 0,
              ratingCount: "0",
              phone: "",
              website: "",
              hoursOfOperation: "",
              detailsNeeded: true,
              detailUrl: "",
            };

            // Extract rating - Multiple selectors for different layouts
            const ratingSelectors = [
              'span[aria-label*="star"]',
              'span[role="img"][aria-label*="star"]',
              'div[class*="MW4etd"]',
              ".section-result-rating",
            ];

            for (const selector of ratingSelectors) {
              const ratingElement = listing.querySelector(selector);
              if (ratingElement) {
                const ratingText =
                  ratingElement.getAttribute("aria-label") ||
                  ratingElement.textContent;
                if (ratingText) {
                  const ratingMatch = ratingText.match(/([0-9.]+)/);
                  if (ratingMatch) {
                    item.rating = parseFloat(ratingMatch[1]);
                    break;
                  }
                }
              }
            }

            // Extract rating count - Multiple selectors
            const reviewSelectors = [
              'span[aria-label*="reviews"]',
              'span[aria-label*="review"]',
              'button[aria-label*="reviews"]',
              ".section-result-num-reviews",
            ];

            for (const selector of reviewSelectors) {
              const reviewElement = listing.querySelector(selector);
              if (reviewElement) {
                const reviewText =
                  reviewElement.getAttribute("aria-label") ||
                  reviewElement.textContent;
                if (reviewText) {
                  const countMatch = reviewText.match(/([0-9,]+)/);
                  if (countMatch) {
                    item.ratingCount = countMatch[1].replace(/,/g, "");
                    break;
                  }
                }
              }
            }

            // Extract category - Multiple selectors
            const categorySelectors = [
              'div[class*="fontBodyMedium"]',
              'span[class*="categoryText"]',
              ".section-result-details > div:first-child",
              'div[class*="W4Efsd"]:not([class*="fontHeadline"])',
              '[data-value] span[class*="fontBodyMedium"]',
            ];

            for (const selector of categorySelectors) {
              const categoryElement = listing.querySelector(selector);
              if (categoryElement) {
                const categoryText = categoryElement.textContent.trim();
                if (
                  categoryText &&
                  !categoryText.includes("★") &&
                  !categoryText.match(/\d+\.\d+/)
                ) {
                  item.category = categoryText.split("·")[0].trim();
                  break;
                }
              }
            }

            // Extract address if available in search results
            const addressSelectors = [
              ".section-result-location",
              'div[class*="fontBodySmall"]',
              'span[class*="fontBodySmall"]',
            ];

            for (const selector of addressSelectors) {
              const addressElement = listing.querySelector(selector);
              if (addressElement) {
                const addressText = addressElement.textContent.trim();
                if (
                  addressText &&
                  addressText.length > 10 &&
                  !addressText.includes("★")
                ) {
                  item.address = addressText;
                  break;
                }
              }
            }

            // Extract the details URL - Multiple approaches
            const linkSelectors = ['a[href*="/maps/place"]', "[data-value]"];

            let detailUrl = "";
            for (const selector of linkSelectors) {
              const linkElement =
                listing.querySelector(selector) || listing.closest(selector);
              if (linkElement) {
                let href = linkElement.getAttribute("href");
                if (!href && linkElement.hasAttribute("data-value")) {
                  // Try to construct URL from data-value
                  const dataValue = linkElement.getAttribute("data-value");
                  if (dataValue) {
                    href = `/maps/place/${dataValue}`;
                  }
                }

                if (href) {
                  detailUrl = href.startsWith("http")
                    ? href
                    : `https://www.google.com${href}`;
                  break;
                }
              }
            }

            item.detailUrl = detailUrl;
            item.detailsNeeded = !!detailUrl;

            results.push(item);
            console.log(`Extracted listing ${results.length}: ${name}`);
          } catch (itemError) {
            console.error("Error processing listing item:", itemError);
          }
        }

        console.log(`Total extracted listings: ${results.length}`);
        return results;
      } catch (err) {
        console.error("Error in bulk extraction:", err);
        return [];
      }
    });

    logger.info(
      chalk.green(
        `Extracted ${bulkExtractedData.length} items from search page`
      )
    );

    // IMPROVED: Process ALL items, not just those with detail URLs
    // First, limit to maxResults to respect user's request
    const allItems = bulkExtractedData.slice(0, options.maxResults);

    // Separate items that need detail extraction vs those we can use as-is
    const itemsWithDetails = allItems.filter(
      (item) => item.detailsNeeded && item.detailUrl
    );
    const itemsWithoutDetails = allItems.filter(
      (item) => !item.detailsNeeded || !item.detailUrl
    );

    logger.info(
      chalk.cyan(
        `Processing ${allItems.length} total items (${itemsWithDetails.length} need detail extraction, ${itemsWithoutDetails.length} already complete)`
      )
    );

    // Start with all items
    const processedItems = [...allItems];
    // Use a more efficient browser context sharing approach
    // Process in smaller batches to avoid overwhelming the browser
    const batchSize = 5;
    const detailParallelLimit = Math.min(3, options.parallelLimit || 2);
    const limit = pLimit(detailParallelLimit);

    // Process items that need detail extraction in batches
    for (let i = 0; i < itemsWithDetails.length; i += batchSize) {
      const batch = itemsWithDetails.slice(i, i + batchSize);
      logger.info(
        chalk.gray(
          `Processing detail batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
            itemsWithDetails.length / batchSize
          )}...`
        )
      );

      await Promise.all(
        batch.map((item, j) =>
          limit(async () => {
            const index = allItems.indexOf(item);
            if (index === -1) return;

            try {
              const detailPage = await browser.newPage();

              // Speed optimization: Minimal resource usage
              await detailPage.setRequestInterception(true);
              detailPage.on("request", (request) => {
                // Only allow essential resources
                const resourceType = request.resourceType();
                if (
                  ["document", "xhr", "fetch", "script"].includes(resourceType)
                ) {
                  request.continue();
                } else {
                  request.abort();
                }
              });

              await setupAntiDetection(detailPage);
              await setupAPIInterception(detailPage);

              // Speed optimization: Shorter timeout
              await detailPage.setDefaultNavigationTimeout(30000);

              // Speed optimization: Much shorter delays between requests
              await sleep(getRandomDelay(300, 800));

              logger.info(
                chalk.gray(
                  `Processing item ${i + j + 1}/${
                    itemsWithDetails.length
                  }: ${item.name.substring(0, 30)}...`
                )
              );

              try {
                // Speed optimization: Use domcontentloaded instead of networkidle2
                await detailPage.goto(item.detailUrl, {
                  waitUntil: "domcontentloaded",
                  timeout: 20000,
                });
              } catch (detailNavErr) {
                logger.warn(
                  chalk.yellow(
                    `Detail page navigation issue: ${detailNavErr.message}`
                  )
                );
                await detailPage.close();
                return;
              }

              // Skip long waiting after navigation
              await sleep(300);

              // Quick extract using DOM
              const quickExtractData = await detailPage.evaluate(() => {
                const extractText = (selector) => {
                  const el = document.querySelector(selector);
                  return el ? el.textContent.trim() : null;
                };

                const phoneLink = document.querySelector('a[href^="tel:"]');
                const phone = phoneLink
                  ? phoneLink.href.replace("tel:", "")
                  : null;

                const websiteLink = document.querySelector(
                  'a[data-item-id="authority"]'
                );
                const website = websiteLink ? websiteLink.href : null;

                const address = extractText(
                  'div[data-item-id="address"] span, button[data-item-id*="address"] span'
                );

                // Hours of operation
                const hoursText = Array.from(
                  document.querySelectorAll('table[aria-label*="hour"] tr')
                )
                  .map((row) => {
                    const day = row.querySelector("th")?.textContent.trim();
                    const hours = row.querySelector("td")?.textContent.trim();
                    return day && hours ? `${day}: ${hours}` : null;
                  })
                  .filter(Boolean)
                  .join("; ");

                return {
                  phone,
                  website,
                  address,
                  hoursOfOperation: hoursText,
                };
              });

              // Update the item with new data
              if (quickExtractData.phone)
                processedItems[index].phone = quickExtractData.phone;
              if (quickExtractData.website)
                processedItems[index].website = quickExtractData.website;
              if (quickExtractData.address)
                processedItems[index].address = quickExtractData.address;
              if (quickExtractData.hoursOfOperation)
                processedItems[index].hoursOfOperation =
                  quickExtractData.hoursOfOperation;

              // Mark as processed
              processedItems[index].detailsNeeded = false;

              await detailPage.close();
              logger.info(
                chalk.green(
                  `Completed item ${i + j + 1}: ${item.name.substring(
                    0,
                    20
                  )}...`
                )
              );
            } catch (err) {
              logger.warn(
                chalk.yellow(
                  `Error processing item ${i + j + 1}: ${err.message}`
                )
              );
            }
          })
        )
      );
    }

    // Format all items for final output
    const finalData = processedItems.map((item) => ({
      name: item.name || "",
      phone: item.phone || "",
      rating: item.rating || 0,
      ratingCount: item.ratingCount || "0",
      address: item.address || "",
      category: item.category || "",
      website: item.website || "",
      hoursOfOperation: item.hoursOfOperation || "",
      photos: [], // Skip photos for faster processing
    }));

    // Filter out items without names
    const validData = finalData.filter((item) => item.name);

    if (mongoConnected && DataModel) {
      await Promise.all(
        validData
          .slice(0, 100)
          .map((item) =>
            DataModel.create(item).catch((err) =>
              logger.error(chalk.red(`MongoDB save error: ${err.message}`))
            )
          )
      );
    }

    logger.info(chalk.green(`Successfully scraped ${validData.length} items`));
    return validData;
  } catch (err) {
    logger.error(chalk.red(`Scraping error: ${err.message}`));
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        logger.warn(chalk.yellow(`Browser close error: ${closeErr.message}`));
      }
    }
  }
};

const startScraping = async (query, options) => {
  const url = query.startsWith("https://www.google.com/maps/search/")
    ? query
    : `https://www.google.com/maps/search/${encodeURIComponent(query)}/`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseFilename = `google_maps_${sanitizeQuery(
    options.keywordsInput || query
  )}_${timestamp}`;
  const filePath = path.join(options.outputDir, `${baseFilename}.xlsx`);

  // Ensure output directory exists
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info(chalk.gray(`Created directory: ${dir}`));
    }

    const wb = xlsx.utils.book_new();
    const headers = [
      "name",
      "phone",
      "rating",
      "ratingCount",
      "address",
      "category",
      "website",
      "hoursOfOperation",
      "photos",
    ];
    const ws = xlsx.utils.aoa_to_sheet([headers]);
    xlsx.utils.book_append_sheet(wb, ws, "GoogleMapsData");
    xlsx.writeFile(wb, filePath);
    logger.info(chalk.green("✓ Initialized Excel file"));
  } catch (err) {
    logger.warn(chalk.yellow(`Excel init error: ${err.message}`));
  }

  const data = await retry(
    () => scrapePage(url, options),
    options.retries,
    getRandomDelay(options.delayMin, options.delayMax)
  );

  const seen = new Map();
  let dupCount = 0;
  let successCount = 0;
  const newData = [];

  for (const item of data) {
    const errors = validateData(item);
    if (errors.length > 0) {
      logger.warn(
        chalk.red(`Invalid data: ${item.name}, ${errors.join(", ")}`)
      );
      continue;
    }

    const nameKey = item.name.toLowerCase().replace(/\s+/g, "");
    const phoneKey = item.phone ? item.phone.replace(/\D/g, "") : "";
    const keys = [
      `${nameKey}|${phoneKey}`,
      phoneKey.length >= 10 ? phoneKey : null,
    ].filter(Boolean);

    if (keys.some((key) => seen.has(key))) {
      logger.warn(chalk.yellow(`Skipping duplicate: ${item.name}`));
      dupCount++;
    } else {
      keys.forEach((key) => seen.set(key, item.name));
      newData.push(item);
      successCount++;
    }
  }

  if (newData.length > 0) {
    saveToExcel(newData, filePath);
  }

  const result = {
    data: newData,
    totalRecords: newData.length,
    newRecords: successCount,
    duplicatesSkipped: dupCount,
    filePath,
    csvPath: filePath.replace(".xlsx", ".csv"),
  };

  logger.info(
    chalk.green(
      `✅ Scraping complete: ${successCount} new records, ${dupCount} duplicates`
    )
  );
  return result;
};

// CLI
const runCLI = async () => {
  console.log(chalk.cyan("=== Google Maps Scraper ==="));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Ask for scrape type - keywords or URLs
  const scrapeType = await new Promise((resolve) => {
    console.log(chalk.green("➜ Choose scraping method:"));
    console.log(chalk.gray("  1. Scrape by keywords (manual input)"));
    console.log(chalk.gray("  2. Scrape by URLs"));
    console.log(chalk.gray("  3. Scrape keywords from keyworddata.txt file"));
    rl.question(chalk.green("➜ Enter choice (1, 2, or 3): "), resolve);
  });

  if (!["1", "2", "3"].includes(scrapeType)) {
    console.log(chalk.red("Error: Invalid choice. Please enter 1, 2, or 3."));
    rl.close();
    return runCLI();
  }

  const isByKeywords = scrapeType === "1";
  const isFromFile = scrapeType === "3";
  const itemsLabel = isByKeywords || isFromFile ? "keywords" : "URLs";

  let items = [];

  if (isFromFile) {
    // Read keywords from keyworddata.txt file
    try {
      const keywordFilePath = path.join(process.cwd(), "keyworddata.txt");
      if (!fs.existsSync(keywordFilePath)) {
        console.log(
          chalk.red(
            "Error: keyworddata.txt file not found in the current directory."
          )
        );
        console.log(
          chalk.yellow(
            "Please create a keyworddata.txt file with one keyword per line."
          )
        );
        rl.close();
        return runCLI();
      }

      const fileContent = fs.readFileSync(keywordFilePath, "utf-8");
      items = fileContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0); // Remove empty lines

      if (items.length === 0) {
        console.log(
          chalk.red(
            "Error: keyworddata.txt file is empty or contains no valid keywords."
          )
        );
        rl.close();
        return runCLI();
      }

      console.log(
        chalk.cyan(
          `✓ Successfully loaded ${items.length} keywords from keyworddata.txt`
        )
      );
      console.log(chalk.gray("Keywords to be processed:"));
      items.forEach((keyword, index) => {
        if (index < 5) {
          console.log(chalk.gray(`  ${index + 1}. ${keyword}`));
        } else if (index === 5) {
          console.log(
            chalk.gray(`  ... and ${items.length - 5} more keywords`)
          );
        }
      });

      // Ask for confirmation
      const proceed = await new Promise((resolve) => {
        console.log(
          chalk.green("➜ Do you want to proceed with these keywords? (y/n):")
        );
        rl.question(chalk.green("➜ "), resolve);
      });

      if (proceed.toLowerCase() !== "y") {
        console.log(chalk.yellow("Operation cancelled."));
        rl.close();
        return runCLI();
      }
    } catch (error) {
      console.log(chalk.red(`Error reading keyworddata.txt: ${error.message}`));
      rl.close();
      return runCLI();
    }
  } else {
    // Original manual input logic
    // Ask for the number of items to scrape
    const itemCountStr = await new Promise((resolve) => {
      console.log(
        chalk.green(`➜ How many ${itemsLabel} do you want to scrape?`)
      );
      rl.question(chalk.green("➜ Enter number: "), resolve);
    });

    const itemCount = parseInt(itemCountStr);
    if (isNaN(itemCount) || itemCount <= 0) {
      console.log(chalk.red("Error: Please enter a valid positive number."));
      rl.close();
      return runCLI();
    }

    // Collect all items (keywords or URLs)
    for (let i = 0; i < itemCount; i++) {
      const item = await new Promise((resolve) => {
        console.log(chalk.green(`➜ Enter ${itemsLabel} #${i + 1}:`));
        rl.question(chalk.green("➜ "), resolve);
      });

      if (!item.trim()) {
        console.log(
          chalk.red(`Error: ${itemsLabel.slice(0, -1)} cannot be empty.`)
        );
        i--; // Retry this item
        continue;
      }

      // Validate URL if scraping by URLs
      if (
        !isByKeywords &&
        !item.trim().startsWith("https://www.google.com/maps")
      ) {
        console.log(chalk.red("Error: Please enter a valid Google Maps URL."));
        i--; // Retry this item
        continue;
      }

      items.push(item.trim());
    }
  }

  // Common scraping options
  const parallelLimit = await new Promise((resolve) => {
    console.log(chalk.green("➜ Max parallel scraping processes (default: 1):"));
    rl.question(chalk.green("➜ "), (answer) => {
      const val = parseInt(answer.trim() || "1");
      resolve(isNaN(val) || val < 1 ? 1 : val);
    });
  });

  const maxResults = await new Promise((resolve) => {
    console.log(chalk.green("➜ Max results per item (default: 136):"));
    rl.question(chalk.green("➜ "), (answer) => {
      const val = parseInt(answer.trim() || "136");
      resolve(isNaN(val) || val < 1 ? 136 : val);
    });
  });

  const headless = await new Promise((resolve) => {
    console.log(chalk.green("➜ Run in headless mode? (y/n, default: y):"));
    rl.question(chalk.green("➜ "), (answer) => {
      resolve((answer.trim() || "y").toLowerCase() === "y");
    });
  });

  // Add a new option for including photos
  const includePhotos = await new Promise((resolve) => {
    console.log(
      chalk.green(
        "➜ Include photos in results? Photos may cause Excel issues (y/n, default: n):"
      )
    );
    rl.question(chalk.green("➜ "), (answer) => {
      resolve((answer.trim() || "n").toLowerCase() === "y");
    });
  });

  // Basic options object
  const options = {
    headless,
    maxResults,
    retries: 2,
    delayMin: 2000,
    delayMax: 5000,
    parallelLimit,
    includePhotos,
    outputDir: path.join(process.cwd(), "google_maps_exports"),
  };

  console.log(
    chalk.cyan(`Starting batch scrape of ${items.length} ${itemsLabel}...`)
  );

  // MongoDB connection
  await connectToMongoDB().catch(() => {
    logger.warn(
      chalk.yellow(
        "MongoDB connection failed - continuing without database storage"
      )
    );
  });

  // Process items in parallel batches
  const limit = pLimit(parallelLimit);
  const allResults = await Promise.all(
    items.map((item, index) =>
      limit(async () => {
        options.keywordsInput = item;
        console.log(
          chalk.cyan(
            `Processing ${itemsLabel.slice(0, -1)} ${index + 1}/${
              items.length
            }: ${item}`
          )
        );
        const query = isByKeywords || isFromFile ? item : item;
        return startScraping(query, options, isByKeywords || isFromFile);
      })
    )
  );

  // Combine all results into a master file
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const masterFilePath = path.join(
    options.outputDir,
    `all_data_${timestamp}.xlsx`
  );
  const masterData = [];
  let totalRecords = 0;

  // Collect unique data
  const seen = new Map();

  for (const result of allResults) {
    if (!result || !result.data || result.data.length === 0) continue;

    for (const item of result.data) {
      const nameKey = item.name.toLowerCase().replace(/\s+/g, "");
      const phoneKey = item.phone ? item.phone.replace(/\D/g, "") : "";
      const uniqueKey = `${nameKey}|${phoneKey}`;

      if (!seen.has(uniqueKey)) {
        seen.set(uniqueKey, true);
        masterData.push(item);
        totalRecords++;
      }
    }
  }

  if (masterData.length > 0) {
    try {
      const wb = xlsx.utils.book_new();
      const ws = xlsx.utils.json_to_sheet(masterData);
      xlsx.utils.book_append_sheet(wb, ws, "AllGoogleMapsData");
      xlsx.writeFile(wb, masterFilePath);
      xlsx.writeFile(wb, masterFilePath.replace(".xlsx", ".csv"), {
        bookType: "csv",
      });
      logger.info(
        chalk.green(`✓ Created master file with ${totalRecords} unique records`)
      );
    } catch (err) {
      logger.error(chalk.red(`Error creating master file: ${err.message}`));
    }
  }

  console.log(chalk.green(`✅ Batch scraping complete!`));
  console.log(chalk.green(`Total unique records: ${totalRecords}`));
  console.log(
    chalk.green(
      `Master files: ${masterFilePath} and ${masterFilePath.replace(
        ".xlsx",
        ".csv"
      )}`
    )
  );

  rl.close();
  process.exit(0);
};

// Express API
const app = express();
app.use(express.json());

app.post("/scrape", async (req, res) => {
  const {
    query,
    maxResults = 20,
    headless = true,
    retries = 3,
    parallelLimit = 1,
  } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Query required" });
  }

  const options = {
    headless,
    maxResults: parseInt(maxResults),
    retries: parseInt(retries),
    delayMin: 10000,
    delayMax: 15000,
    parallelLimit: parseInt(parallelLimit),
    outputDir: path.join(process.cwd(), "google_maps_exports"),
    keywordsInput: query,
  };

  try {
    await connectToMongoDB();
    const result = await startScraping(query, options);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run CLI if executed directly, otherwise start server
if (import.meta.url === new URL(import.meta.url).href) {
  // Check if CLI mode is requested
  const args = process.argv.slice(2);
  if (args.includes("--server") || process.env.NODE_ENV === "server") {
    // Start Express server
    const PORT = process.env.PORT || 3081;
    app.listen(PORT, () =>
      logger.info(chalk.green(`Server running on port ${PORT}`))
    );
  } else {
    // Run CLI interface
    runCLI();
  }
}

// Export functions for testing
export { startScraping, connectToMongoDB, autoScrollGoogleMaps, scrapePage };
