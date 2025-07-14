# 🗺️ Google Maps Business Scraper

[![GitHub stars](https://img.shields.io/github/stars/kunaldevelopers/Google-Maps-Business-Scraper?style=social)](https://github.com/kunaldevelopers/Google-Maps-Business-Scraper/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/kunaldevelopers/Google-Maps-Business-Scraper?style=social)](https://github.com/kunaldevelopers/Google-Maps-Business-Scraper/network)
[![GitHub issues](https://img.shields.io/github/issues/kunaldevelopers/Google-Maps-Business-Scraper)](https://github.com/kunaldevelopers/Google-Maps-Business-Scraper/issues)
[![License](https://img.shields.io/github/license/kunaldevelopers/Google-Maps-Business-Scraper)](https://github.com/kunaldevelopers/Google-Maps-Business-Scraper/blob/main/LICENSE)

> **Extract business leads from Google Maps with advanced scraping. Get contact info, reviews, ratings & export to Excel. Free alternative to paid tools.**

A powerful command-line Google Maps business data scraper that extracts comprehensive business information including contact details, reviews, ratings, and more. Built with Puppeteer stealth technology and advanced API interception to avoid detection and ensure reliable data extraction.

## 🚀 Key Features

- 🎯 **CLI-Based Interface** - Easy-to-use command line interface for bulk scraping
- 📊 **Comprehensive Data Extraction** - Name, address, phone, website, ratings, reviews, hours
- 📁 **Multiple Input Methods** - Manual keyword input, batch keywords, or keyword file import
- 📱 **Multiple Export Formats** - Excel (.xlsx), CSV with automatic duplicate removal
- 🛡️ **Advanced Anti-Detection** - Puppeteer Extra with stealth plugin and randomized delays
- 🔄 **Batch Processing** - Process multiple keywords simultaneously with parallel execution
- 📈 **Progress Tracking** - Real-time progress monitoring with beautiful console output
- 💾 **Database Integration** - Optional MongoDB support for data storage
- 📝 **Detailed Logging** - Comprehensive logging system with file output
- ⚡ **High Performance** - Aggressive scrolling to extract up to 136+ results per search
- 📄 **Keyword File Support** - Import keywords from `keyworddata.txt` file
- 🎚️ **Configurable Options** - Headless mode, parallel limits, max results per search

## 📸 How It Works

1. **Input Keywords**: Enter search terms like "restaurants in New York" or "dentists near me"
2. **Advanced Scrolling**: Automatically scrolls Google Maps to load ALL available listings
3. **API Interception**: Captures Google's internal API responses for maximum data extraction
4. **Detail Enhancement**: Visits individual business pages to extract phone numbers and websites
5. **Export Results**: Saves data to Excel/CSV with automatic deduplication

## 🛠️ Installation

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Chrome/Chromium browser

### Quick Start

1. **Clone the repository**

   ```bash
   git clone https://github.com/kunaldevelopers/Google-Maps-Business-Scraper.git
   cd Google-Maps-Business-Scraper
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start scraping**
   ```bash
   npm start
   ```

## 📋 Usage Guide

### Method 1: Manual Keyword Input

```bash
npm start
```

Then choose option 1 and enter keywords one by one:

- "restaurants in London"
- "dentists near Manchester"
- "hotels in Birmingham"

### Method 2: Batch Keywords from File

1. Create/edit `keyworddata.txt` in the project root:

   ```
   Vegan grocery stores near Camden London
   Best vegan food shops in Shoreditch
   Coffee shops in central London
   Organic restaurants near Westminster
   ```

2. Run the scraper:

   ```bash
   npm start
   ```

3. Choose option 3 to load keywords from file

### Method 3: Direct Google Maps URLs

```bash
npm start
```

Choose option 2 and enter direct Google Maps search URLs:

```
https://www.google.com/maps/search/restaurants+in+london/
```

### Configuration Options

When running the CLI, you'll be prompted for:

- **Parallel Processing**: Number of simultaneous scraping processes (1-5 recommended)
- **Max Results**: Results per keyword (default: 136, can extract up to 150+)
- **Headless Mode**: Run browser in background (recommended: Yes)
- **Include Photos**: Extract business photos (warning: may cause Excel file issues)

## 📊 Data Fields Extracted

| Field                  | Description                     | Source                     |
| ---------------------- | ------------------------------- | -------------------------- |
| **Business Name**      | Name of the business            | Google Maps listing        |
| **Phone Number**       | Contact phone number            | Business detail page + API |
| **Address**            | Full business address           | Google Maps listing        |
| **Website**            | Business website URL            | Business detail page       |
| **Rating**             | Google Maps rating (1-5 stars)  | Google Maps API            |
| **Review Count**       | Total number of reviews         | Google Maps API            |
| **Category**           | Business category/type          | Google Maps listing        |
| **Hours of Operation** | Business opening hours          | Business detail page       |
| **Photos**             | Business photos URLs (optional) | Google Maps images         |

## ⚙️ Advanced Configuration

### Environment Variables

Create a `.env` file in the root directory:

```env
# Database Configuration (Optional)
MONGODB_URI=mongodb://localhost:27017/google-maps-scraper

# Scraping Configuration
MAX_CONCURRENT_PAGES=3
REQUEST_DELAY=2000
HEADLESS_MODE=true

# Export Configuration
OUTPUT_DIRECTORY=./google_maps_exports
```

### Keyword File Format

The `keyworddata.txt` file should contain one search query per line:

```
restaurants in New York
dentists near London Bridge
coffee shops in Manchester city center
vegan food stores near Camden
hotels in Birmingham UK
car repair shops in Leeds
```

### Performance Optimization

- **Parallel Limit**: Start with 1-2, increase carefully to avoid IP blocking
- **Max Results**: Default 136 works well, higher numbers may trigger CAPTCHA
- **Delays**: Built-in randomized delays prevent detection

## 🔧 API Reference

### Express Server Mode

Start as API server:

```bash
npm start -- --server
```

#### POST /scrape

```javascript
{
  "query": "restaurants in London",
  "maxResults": 50,
  "headless": true,
  "retries": 3,
  "parallelLimit": 2
}
```

**Response:**

```javascript
{
  "data": [
    {
      "name": "Restaurant Name",
      "phone": "+44 20 1234 5678",
      "rating": 4.5,
      "ratingCount": "123",
      "address": "123 Main St, London",
      "category": "Restaurant",
      "website": "https://restaurant.com",
      "hoursOfOperation": "Mon: 9-17; Tue: 9-17...",
      "photos": ["photo_url_1", "photo_url_2"]
    }
  ],
  "totalRecords": 45,
  "newRecords": 45,
  "duplicatesSkipped": 0,
  "filePath": "./exports/data.xlsx",
  "csvPath": "./exports/data.csv"
}
```

## 🗂️ Output Files

### Individual Search Files

- `google_maps_[keyword]_[timestamp].xlsx`
- `google_maps_[keyword]_[timestamp].csv`

### Master Combined File

- `all_data_[timestamp].xlsx` - Contains all unique results from batch processing
- `all_data_[timestamp].csv` - CSV version of master file

### Log Files

- `scraper.log` - Detailed operation logs

## 🛡️ Anti-Detection Features

- **Stealth Plugin**: Hides automation indicators
- **Randomized Delays**: Human-like browsing patterns
- **User Agent Rotation**: Appears as real browser
- **Resource Optimization**: Only loads essential page elements
- **CAPTCHA Detection**: Automatic detection with screenshot capture
- **IP Protection**: Built-in request limiting

## 🚦 Best Practices

### Search Query Tips

- Use specific locations: "restaurants in Camden, London" vs "restaurants"
- Include relevant qualifiers: "best", "near", "top rated"
- Try variations: "dentist", "dental clinic", "dental practice"

### Performance Guidelines

- Start with 1 parallel process for testing
- Monitor for CAPTCHAs if increasing parallel processing
- Use smaller batches (20-30 keywords) for stability
- Run during off-peak hours for better performance

### Legal Compliance

- Respect Google's rate limits and terms of service
- Use scraped data responsibly and ethically
- Implement appropriate delays between requests
- Don't overwhelm Google's servers

## 🛡️ Legal & Ethical Use

⚠️ **Important Notice:**

- This tool is for educational and research purposes only
- Respect Google's Terms of Service and robots.txt
- Implement appropriate delays between requests
- Don't overload Google's servers
- Use scraped data responsibly and in compliance with data protection laws

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🐛 Issues & Support

If you encounter any issues or need support:

1. Check the [Issues](https://github.com/kunaldevelopers/Google-Maps-Business-Scraper/issues) page
2. Create a new issue with detailed description
3. Include log files and error messages
4. Contact the developer (details below)

## 👨‍💻 Developer

**Kunal Kumar Pandit**

- 📧 Email: kunalkprnc@gmail.com
- 📱 WhatsApp: +91 9471376362
- 💼 LinkedIn: [Kunal Kumar Pandit](https://linkedin.com/in/kunal-kumar-pandit)
- 🌐 Website: [www.cyberkunal.com](https://www.cyberkunal.com)
- 🐙 GitHub: [@kunaldevelopers](https://github.com/kunaldevelopers)

## ⭐ Show Your Support

If this project helped you, please give it a ⭐ star on GitHub!

## 📈 Roadmap

- [ ] Add GUI interface for non-technical users
- [ ] Implement proxy rotation for larger scale scraping
- [ ] Add email extraction from business websites
- [ ] Support for multiple countries/languages
- [ ] Add data validation and cleaning features
- [ ] Integration with CRM systems
- [ ] Real-time scraping dashboard
- [ ] Mobile app for on-the-go scraping

## 🙏 Acknowledgments

- [Puppeteer](https://pptr.dev/) for browser automation
- [Puppeteer Extra](https://github.com/berstend/puppeteer-extra) for stealth capabilities
- [Cheerio](https://cheerio.js.org/) for server-side HTML parsing
- [ExcelJS](https://github.com/exceljs/exceljs) for Excel file generation
- [Winston](https://github.com/winstonjs/winston) for logging
- [Chalk](https://github.com/chalk/chalk) for beautiful console output

---

<div align="center">
  <b>Made with ❤️ by <a href="https://github.com/kunaldevelopers">Kunal Kumar Pandit</a></b>
</div>
