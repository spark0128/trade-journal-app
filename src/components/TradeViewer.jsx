import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AdvancedChart } from "react-tradingview-embed";
import jsPDF from "jspdf";

// Constants for P/L calculation
const TICK_SIZE = 0.1;
const LOT_SIZE = 1;
// XAUUSD (Gold) multiplier - $1 move equals this amount per lot
const XAUUSD_MULTIPLIER = 100;  // Updated from 10 to 100 for correct P/L calculation

// Fixed Forex.com XAUUSD chart (timestamps in sync; price is illustrative)
const chartSymbol = 'OANDA:XAUUSD';

// Convert Date to New York time string
const toNYTime = (dt) =>
  dt.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

// Parse timestamp to Date
const parseTime = (raw) => {
  const dt = new Date(raw);
  if (isNaN(dt)) throw new Error(`Invalid time: ${raw}`);
  return dt;
};

// Add after imports
const DEBUG = true; // Enable/disable detailed logging
const INCLUDE_OPEN_POSITIONS = true; // Show unmatched entries as open positions

export default function TradeViewer() {
  const [tradeList, setTradeList] = useState([]);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [notification, setNotification] = useState("");
  // Updated to store multiple images per trade
  const [tradeImages, setTradeImages] = useState({});
  const [uploadingFor, setUploadingFor] = useState(null);
  const [uploadSlot, setUploadSlot] = useState(0); // 0, 1, or 2 for up to 3 images
  const [isExporting, setIsExporting] = useState(false);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [pendingImageUploads, setPendingImageUploads] = useState(0);

  const isCSV = (file) => file.type === "text/csv" || file.name.toLowerCase().endsWith(".csv");

  const parseCSV = (file) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const lines = ev.target.result.trim().split("\n");
        if (lines.length < 2) throw new Error("CSV has no data rows.");

        // Get headers from first line
        const headers = lines[0].split(/,|\t/).map(h => h.trim());
        if (DEBUG) {
          console.log("CSV Headers:", headers);
        }

        // Map column indices for easier access
        const columnMap = {};
        headers.forEach((header, index) => {
          columnMap[header.toLowerCase()] = index;
        });

        // Check required columns
        const requiredColumns = [
          'symbol', 'buyprice', 'sellprice', 'qty', 'boughttimestamp', 'soldtimestamp', 'pnl'
        ];
        
        const missingColumns = requiredColumns.filter(col => 
          !Object.keys(columnMap).some(key => key.includes(col.toLowerCase()))
        );
        
        if (missingColumns.length > 0) {
          throw new Error(`Missing required columns: ${missingColumns.join(', ')}`);
        }

        // Find actual column indices (handling variations in header names)
        const getColumnIndex = (baseName) => {
          return Object.keys(columnMap).findIndex(key => key.includes(baseName.toLowerCase()));
        };

        const symbolCol = getColumnIndex('symbol');
        const buyPriceCol = getColumnIndex('buyprice');
        const sellPriceCol = getColumnIndex('sellprice');
        const qtyCol = getColumnIndex('qty');
        const buyTimeCol = getColumnIndex('boughttimestamp');
        const sellTimeCol = getColumnIndex('soldtimestamp');
        const pnlCol = getColumnIndex('pnl');
        const durationCol = getColumnIndex('duration');

        if (DEBUG) {
          console.log("Column indices:", {
            symbol: symbolCol,
            buyPrice: buyPriceCol,
            sellPrice: sellPriceCol,
            qty: qtyCol,
            buyTime: buyTimeCol,
            sellTime: sellTimeCol,
            pnl: pnlCol,
            duration: durationCol
          });
        }

        // Parse data rows
        const trades = [];
        for (let i = 1; i < lines.length; i++) {
          // Skip empty lines
          if (!lines[i].trim()) continue;

          try {
            // Split by comma or tab
            const fields = lines[i].split(/,|\t/).map(f => f.trim());
            if (DEBUG) {
              console.log(`Row ${i} fields:`, fields);
            }

            if (fields.length < Math.max(symbolCol, buyPriceCol, sellPriceCol, qtyCol, buyTimeCol, sellTimeCol, pnlCol) + 1) {
              console.warn(`Skipping row ${i}: insufficient fields`);
              continue;
            }

            // Parse values
            const symbol = fields[symbolCol];
            const buyPrice = parseFloat(fields[buyPriceCol]);
            const sellPrice = parseFloat(fields[sellPriceCol]);
            const quantity = parseFloat(fields[qtyCol]);
            
            // Parse timestamps
            let buyTimestamp, sellTimestamp;
            try {
              buyTimestamp = new Date(fields[buyTimeCol]);
              sellTimestamp = new Date(fields[sellTimeCol]);
              
              if (isNaN(buyTimestamp.getTime()) || isNaN(sellTimestamp.getTime())) {
                throw new Error("Invalid timestamp format");
              }
            } catch (err) {
              console.warn(`Row ${i}: Error parsing timestamps. Using current date.`, err);
              buyTimestamp = new Date();
              sellTimestamp = new Date(buyTimestamp.getTime() + 3600000); // 1 hour later
            }
            
            // Parse P&L
            let pnl = 0;
            let originalPnlString = ""; // Store the original string format
            let shouldDisplayAsNegative = false; // Track if PnL should display as negative
            
            try {
              // Try to parse pnl with currency symbol and handle parentheses for negative values
              const pnlString = fields[pnlCol].trim();
              
              // Specific case for $(xxx.xx) format
              const dollarInParenthesesRegex = /^\$\((\d+\.\d+)\)$/;
              const dollarParenthesesMatch = pnlString.match(dollarInParenthesesRegex);
              
              // Special case for exact format $(225.00)
              if (pnlString.startsWith('$(') && pnlString.endsWith(')')) {
                // Extract just the number
                let numericPart = pnlString.substring(2, pnlString.length - 1);
                originalPnlString = `-$${numericPart}`;
                shouldDisplayAsNegative = true;
                pnl = -parseFloat(numericPart);
                console.log(`Converted ${pnlString} to ${originalPnlString}`);
              }
              // Regular parentheses case
              else if (pnlString.startsWith('(') && pnlString.endsWith(')')) {
                // Remove parentheses and add minus sign
                let valueWithoutParens = pnlString.substring(1, pnlString.length - 1);
                originalPnlString = `-$${valueWithoutParens.replace(/[$£€]/g, '')}`;
                shouldDisplayAsNegative = true;
                
                // Remove parentheses, currency symbols, and commas for proper parsing
                const cleanPnlString = valueWithoutParens.replace(/[$£€,]/g, '').trim();
                pnl = -Math.abs(parseFloat(cleanPnlString));
              } 
              // Has minus sign case
              else if (pnlString.startsWith('-')) {
                originalPnlString = pnlString;
                shouldDisplayAsNegative = true;
                
                // Remove currency symbols and commas for proper parsing
                const cleanPnlString = pnlString.replace(/[$£€,]/g, '').trim();
                pnl = parseFloat(cleanPnlString);
              }
              // Normal positive number
              else {
                originalPnlString = pnlString;
                shouldDisplayAsNegative = false;
                
                // Remove currency symbols and commas for proper parsing
                const cleanPnlString = pnlString.replace(/[$£€,]/g, '').trim();
                pnl = parseFloat(cleanPnlString);
              }
              
              if (isNaN(pnl)) {
                // Fallback: calculate from prices based on trade direction
                const direction = buyPrice > sellPrice ? -1 : 1; // Short is -1, Long is 1
                pnl = direction * (sellPrice - buyPrice) * quantity * XAUUSD_MULTIPLIER;
              }
            } catch (err) {
              console.warn(`Row ${i}: Error parsing P&L. Calculating from prices.`, err);
              const direction = buyPrice > sellPrice ? -1 : 1; // Short is -1, Long is 1
              pnl = direction * (sellPrice - buyPrice) * quantity * XAUUSD_MULTIPLIER;
            }
            
            // Get duration if available
            let duration = "";
            if (durationCol >= 0 && durationCol < fields.length) {
              duration = fields[durationCol];
            } else {
              // Calculate duration
              const durationMs = sellTimestamp - buyTimestamp;
              const durationMinutes = Math.floor(durationMs / (1000 * 60));
              duration = durationMinutes >= 60 
                ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m` 
                : `${durationMinutes}m`;
            }

            // Determine if long or short based on buy/sell prices
            const tradeDirection = buyPrice <= sellPrice ? "Long" : "Short";
            
            trades.push({
              id: i,
              instrument: symbol,
              entryTime: buyTimestamp.toISOString(),
              exitTime: sellTimestamp.toISOString(),
              entryNY: toNYTime(buyTimestamp),
              exitNY: toNYTime(sellTimestamp),
              quantity,
              entryPrice: buyPrice,
              exitPrice: sellPrice,
              profitLoss: pnl,
              originalPnlString, // Store the formatted string
              shouldDisplayAsNegative, // Flag for display purposes
              tradeType: tradeDirection,
              isWinning: !shouldDisplayAsNegative, // Winning if not negative in CSV
              description: `${tradeDirection} ${quantity} ${symbol} @ ${buyPrice}, Exit @ ${sellPrice}`,
              exitReason: "Market Exit",
              duration,
              durationMs: sellTimestamp - buyTimestamp
            });
            
            if (DEBUG) {
              console.log(`Parsed trade ${i}:`, trades[trades.length - 1]);
            }
          } catch (rowErr) {
            console.error(`Error parsing row ${i}:`, rowErr, lines[i]);
          }
        }

        if (trades.length === 0) {
          throw new Error("No valid trades found in CSV");
        }

        // Sort trades by entry time (most recent first)
        trades.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime));

        setTradeList(trades);
        setSelectedTrade(trades[0]);
        setNotification(`Imported ${trades.length} trades from CSV`);
        setTimeout(() => setNotification(""), 3000);
      } catch (err) {
        console.error("CSV parse error:", err);
        setNotification(`Error: ${err.message}`);
        setTimeout(() => setNotification(""), 3000);
      }
    };
    reader.readAsText(file);
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files[0];
    if (file && isCSV(file)) parseCSV(file);
    else {
      setNotification("Error: Select a valid CSV file.");
      setTimeout(() => setNotification(""), 3000);
    }
    e.target.value = null;
  };

  const handleFileDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && isCSV(file)) parseCSV(file);
    else {
      setNotification("Error: Drop a valid CSV file.");
      setTimeout(() => setNotification(""), 3000);
    }
  };

  const preventDefaults = (e) => { e.preventDefault(); e.stopPropagation(); };

  // Add sample trades if none exist
  useEffect(() => {
    // Remove the entire sample trade creation logic
    // This will ensure no trades are shown on page reload
    console.log("No trades will be added on initialization");
  }, []);

  // Add function to handle image uploads
  const handleImageUpload = (e) => {
    if (!uploadingFor || uploadSlot === undefined) return;
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotification("Only image files are accepted");
      setTimeout(() => setNotification(""), 3000);
      return;
    }
    
    // Set loading state when upload starts
    setImagesLoading(true);
    setPendingImageUploads(prev => prev + 1);
    
    const reader = new FileReader();
    reader.onload = () => {
      // Create a new Image to track when it's fully loaded
      const img = new Image();
      img.onload = () => {
        // Only decrease counter when image is fully loaded
        setPendingImageUploads(prev => {
          const newCount = prev - 1;
          if (newCount <= 0) {
            setImagesLoading(false);
          }
          return newCount;
        });
      };
      
      // Update trade images with the new image in the specified slot
      setTradeImages(prev => {
        const tradeImagesArray = prev[uploadingFor] || [null, null, null];
        const updatedImages = [...tradeImagesArray];
        updatedImages[uploadSlot] = reader.result;
        return { 
          ...prev, 
          [uploadingFor]: updatedImages 
        };
      });
      
      img.src = reader.result; // Start loading the image
      
      setNotification(`Image ${uploadSlot + 1} added successfully`);
      setTimeout(() => setNotification(""), 3000);
      setUploadingFor(null);
      setUploadSlot(undefined);
    };
    reader.onerror = () => {
      setNotification("Error reading image file");
      setTimeout(() => setNotification(""), 3000);
      setUploadingFor(null);
      setUploadSlot(undefined);
      setPendingImageUploads(prev => {
        const newCount = prev - 1;
        if (newCount <= 0) {
          setImagesLoading(false);
        }
        return newCount;
      });
    };
    reader.readAsDataURL(file);
    e.target.value = null;
  };

  // Start image upload for a specific slot
  const startImageUpload = (tradeId, slot) => {
    setUploadingFor(tradeId);
    setUploadSlot(slot);
    // The actual file selection will be triggered by the ref
  };

  // Remove an image from a specific slot
  const removeImage = (tradeId, slot) => {
    setTradeImages(prev => {
      if (!prev[tradeId]) return prev;
      
      const updatedImages = [...prev[tradeId]];
      updatedImages[slot] = null;
      
      // If all slots are null, remove the entry
      if (updatedImages.every(img => img === null)) {
        const newImages = {...prev};
        delete newImages[tradeId];
        return newImages;
      }
      
      return { 
        ...prev, 
        [tradeId]: updatedImages 
      };
    });
  };

  // Export all trades to PDF
  const handleExportPDF = async () => {
    if (!tradeList.length || isExporting) return;
    
    try {
      setIsExporting(true);
      setNotification("Preparing PDF export...");
      
      const doc = new jsPDF();
      
      // Helper to load image and get aspect ratio
      const loadImage = (src) => new Promise((resolve) => {
        const img = new window.Image();
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.onerror = () => resolve(null);
        img.src = src;
      });
      
      for (let idx = 0; idx < tradeList.length; idx++) {
        const trade = tradeList[idx];
        if (idx > 0) doc.addPage();
        
        // Update notification with progress
        setNotification(`Exporting trade ${idx + 1} of ${tradeList.length}...`);
        
        doc.setFontSize(18);
        doc.text(`Trade #${trade.id}: ${trade.instrument}`, 10, 20);
        doc.setFontSize(12);
        doc.text(`Type: ${trade.tradeType}`, 10, 35);
        doc.text(`Entry Time: ${trade.entryNY || trade.entryTime}`, 10, 45);
        doc.text(`Exit Time: ${trade.exitNY || trade.exitTime}`, 10, 55);
        doc.text(`Entry Price: ${trade.entryPrice}`, 10, 65);
        doc.text(`Exit Price: ${trade.exitPrice}`, 10, 75);
        doc.text(`Quantity: ${trade.quantity}`, 10, 85);
        doc.text(`Profit/Loss: ${trade.profitLoss < 0 ? '-' : ''}$${Math.abs(trade.profitLoss).toFixed(2)}`, 10, 95);
        if (trade.description) doc.text(`Description: ${trade.description}`, 10, 110);
        
        // Add images if available
        const tradeImagesArray = tradeImages[trade.id];
        if (tradeImagesArray && tradeImagesArray.some(img => img !== null)) {
          const pageWidth = doc.internal.pageSize.getWidth();
          const margin = 10;
          const imgWidth = pageWidth - margin * 2;
          let yPosition = 120;
          
          for (let i = 0; i < tradeImagesArray.length; i++) {
            const imageData = tradeImagesArray[i];
            if (!imageData) continue;
            
            const imgInfo = await loadImage(imageData);
            if (imgInfo && imgInfo.width && imgInfo.height) {
              // Calculate height based on aspect ratio
              const imgHeight = imgWidth * (imgInfo.height / imgInfo.width);
              
              // Check if we need a new page for this image
              if (yPosition + imgHeight > doc.internal.pageSize.getHeight() - 10) {
                doc.addPage();
                yPosition = 20; // Reset Y position on new page
              }
              
              doc.addImage(imageData, 'JPEG', margin, yPosition, imgWidth, imgHeight);
              yPosition += imgHeight + 10; // Add spacing between images
            }
          }
        }
      }
      
      doc.save("trades.pdf");
      setNotification("PDF export completed!");
      setTimeout(() => setNotification(""), 3000);
    } catch (error) {
      console.error("Export error:", error);
      setNotification("Error exporting PDF. Please try again.");
      setTimeout(() => setNotification(""), 3000);
    } finally {
      setIsExporting(false);
    }
  };

  // Preload all images when tradeImages state changes
  useEffect(() => {
    const preloadImages = async () => {
      // Flatten the images from all trades and slots
      const imagesToLoad = Object.values(tradeImages)
        .flatMap(imageArray => Array.isArray(imageArray) ? imageArray : [imageArray])
        .filter(Boolean);
      
      if (imagesToLoad.length === 0) return;
      
      try {
        setImagesLoading(true);
        setNotification(`Loading ${imagesToLoad.length} images...`);
        
        // Create Image objects for all images to preload them
        const promises = imagesToLoad.map(src => {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`Failed to load image: ${src?.substring(0, 30)}...`));
            img.src = src;
          });
        });
        
        await Promise.all(promises);
        setImagesLoading(false);
        setNotification("All images loaded.");
        setTimeout(() => setNotification(""), 1500);
      } catch (error) {
        console.error("Image preload error:", error);
        setNotification("Warning: Some images failed to load.");
        setTimeout(() => setNotification(""), 3000);
        setImagesLoading(false);
      }
    };
    
    preloadImages();
  }, [tradeImages]);

  return (
    <div className="flex flex-col h-screen">
      {/* Navbar */}
      <div className="flex justify-between items-center bg-blue-600 text-white p-4 relative">
        <h1 className="text-2xl font-bold">Trade Viewer</h1>
        <div className="flex space-x-2">
          <label htmlFor="csv-upload" className="bg-white text-blue-600 px-4 py-2 rounded-lg cursor-pointer">
            Upload CSV
          </label>
          <input id="csv-upload" type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" />
          <button 
            onClick={handleExportPDF} 
            className={`px-4 py-2 rounded-lg ${
              isExporting || imagesLoading || pendingImageUploads > 0
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                : 'bg-white text-blue-600 hover:bg-blue-50'
            }`}
            disabled={isExporting || imagesLoading || pendingImageUploads > 0}
          >
            {isExporting ? 'Preparing Export...' : imagesLoading ? 'Loading Images...' : 'Export All Trades'}
          </button>
        </div>
        {notification && <div className="absolute top-full mt-2 right-4 bg-green-500 text-white px-4 py-2 rounded shadow-lg">{notification}</div>}
      </div>

      <div className="flex flex-1 relative overflow-hidden">
        {/* Trades List */}
        <div onDrop={handleFileDrop} onDragOver={preventDefaults} className="w-1/3 bg-gray-100 p-4 overflow-y-auto border-r-2 border-gray-300">
          <h2 className="text-xl font-bold mb-4">Trades (Drop CSV here)</h2>
          {tradeList.length > 0 ? (
            <ul className="space-y-2">
              {tradeList.map((trade) => (
                <li 
                  key={trade.id}
                  onClick={() => setSelectedTrade(trade)}
                  className={`p-4 rounded-lg cursor-pointer transition-all duration-200 ${
                    selectedTrade?.id === trade.id 
                      ? 'bg-blue-200 border-l-4 border-blue-600' 
                      : 'bg-white hover:bg-blue-50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="font-medium">{trade.instrument}</div>
                    <div className="flex items-center gap-1">
                      <div className={`text-xs font-semibold px-2 py-1 rounded-full ${
                        trade.tradeType === 'Long' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {trade.tradeType}
                      </div>
                      {trade.profitLoss < 0 && (
                        <div className="text-xs font-semibold px-2 py-1 rounded-full bg-red-100 text-red-800">
                          Loss
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="text-sm text-gray-500 mb-1 flex justify-between">
                    <span>{new Date(trade.entryTime).toLocaleDateString()} {trade.entryNY.split(' ')[1]}</span>
                    {trade.duration && <span className="text-gray-400">{trade.duration}</span>}
                  </div>
                  
                  <div className="flex justify-between items-center mt-2">
                    <div className="text-sm">
                      <span className="inline-block w-3 h-3 rounded-full bg-green-500 mr-1"></span>
                      {trade.entryPrice}
                      <span className="mx-2">→</span>
                      <span className="inline-block w-3 h-3 rounded-full bg-red-500 mr-1"></span>
                      {trade.exitPrice}
                    </div>
                    <div className={`font-medium ${
                      trade.shouldDisplayAsNegative ? 'text-red-600' : 'text-green-600'
                    }`}>
                      {trade.originalPnlString || (trade.profitLoss < 0 
                        ? `-$${Math.abs(trade.profitLoss).toFixed(2)}` 
                        : `$${trade.profitLoss.toFixed(2)}`)}
                    </div>
                  </div>
                  
                  {trade.exitReason && (
                    <div className="mt-1 text-xs text-gray-500">
                      {trade.exitReason}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="bg-white p-4 rounded-lg border border-gray-200 text-center text-gray-500">
              No trades available. Upload a CSV file or create a trade.
            </div>
          )}
        </div>

        {/* Trade Detail */}
        <div className="flex-1 p-8 overflow-y-auto flex flex-col min-h-0">
          {selectedTrade ? (
            <>  
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center">
                  <h2 className="text-2xl font-bold">{selectedTrade.instrument}</h2>
                </div>
                <div className={`px-3 py-1 rounded-lg font-medium ${
                  selectedTrade.shouldDisplayAsNegative 
                    ? 'bg-red-100 text-red-800' 
                    : 'bg-green-100 text-green-800'
                }`}>
                  {selectedTrade.originalPnlString || (selectedTrade.profitLoss < 0 
                    ? `-$${Math.abs(selectedTrade.profitLoss).toFixed(2)}`
                    : `$${selectedTrade.profitLoss.toFixed(2)}`)
                  }
                </div>
              </div>
              
              <div className="mb-4 bg-gray-50 p-4 rounded-lg">
                <div className="grid grid-cols-2 gap-x-8 gap-y-2">
                  <div>
                    <span className="text-gray-500 text-sm">Entry Time:</span>
                    <div className="font-medium">{selectedTrade.entryNY}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 text-sm">Exit Time:</span>
                    <div className="font-medium">{selectedTrade.exitNY}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 text-sm">Entry Price:</span>
                    <div className="font-medium">{selectedTrade.entryPrice}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 text-sm">Exit Price:</span>
                    <div className="font-medium">{selectedTrade.exitPrice}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 text-sm">Quantity:</span>
                    <div className="font-medium">{selectedTrade.quantity}</div>
                  </div>
                  <div>
                    <span className="text-gray-500 text-sm">Type:</span>
                    <div className={`font-medium ${selectedTrade.tradeType==='Long'?'text-green-600':'text-red-600'}`}>
                      {selectedTrade.tradeType}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-500 text-sm">Duration:</span>
                    <div className="font-medium">{selectedTrade.duration || 'N/A'}</div>
                  </div>
                </div>
              </div>
              
              <div className="flex-1 min-h-0 mb-4 border border-gray-200 rounded-lg overflow-auto">
                {/* Display the image gallery or upload UI */}
                <div className="flex flex-col h-full">
                  {/* If there are any images, show them */}
                  {tradeImages[selectedTrade.id] && tradeImages[selectedTrade.id].some(img => img !== null) ? (
                    <div className="grid grid-cols-1 gap-4 p-4">
                      {tradeImages[selectedTrade.id].map((image, index) => (
                        image ? (
                          <div key={index} className="relative border rounded-lg overflow-hidden">
                            <img 
                              src={image} 
                              alt={`Trade ${selectedTrade.id} image ${index + 1}`} 
                              className="w-full h-auto"
                            />
                            <div className="absolute top-2 right-2 flex gap-2">
                              <button 
                                className="bg-blue-500 text-white p-1 rounded-full hover:bg-blue-600"
                                onClick={() => startImageUpload(selectedTrade.id, index)}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                  <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                                </svg>
                              </button>
                              <button 
                                className="bg-red-500 text-white p-1 rounded-full hover:bg-red-600"
                                onClick={() => removeImage(selectedTrade.id, index)}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div key={index} className="flex flex-col items-center justify-center h-40 bg-gray-50 border rounded-lg border-dashed">
                            <button 
                              className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                              onClick={() => startImageUpload(selectedTrade.id, index)}
                            >
                              Add Image {index + 1}
                            </button>
                          </div>
                        )
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-64 bg-gray-50">
                      <svg className="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true">
                        <path 
                          d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" 
                          strokeWidth="2" 
                          strokeLinecap="round" 
                          strokeLinejoin="round" 
                        />
                      </svg>
                      <p className="mt-1 text-sm text-gray-600">No images for this trade</p>
                      <div className="mt-4 flex gap-2">
                        <button 
                          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                          onClick={() => startImageUpload(selectedTrade.id, 0)}
                        >
                          Add Image 1
                        </button>
                        <button 
                          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                          onClick={() => startImageUpload(selectedTrade.id, 1)}
                        >
                          Add Image 2
                        </button>
                        <button 
                          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
                          onClick={() => startImageUpload(selectedTrade.id, 2)}
                        >
                          Add Image 3
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="mb-4">
                <h3 className="text-lg font-medium mb-2">Notes</h3>
                <textarea 
                  className="w-full p-3 border border-gray-300 rounded-lg h-24"
                  placeholder="Add notes about this trade..."
                ></textarea>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-gray-500">
                <svg className="w-16 h-16 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                </svg>
                <p className="text-xl font-medium">No trade selected</p>
                <p className="mt-2">Select a trade from the list or upload a CSV file</p>
              </div>
            </div>
          )}
        </div>

        {/* Create Trade Modal */}
        <AnimatePresence>
          {showCreateForm && (
            <>
              <motion.div initial={{opacity:0}} animate={{opacity:0.5}} exit={{opacity:0}} className="absolute inset-0 bg-black z-10" onClick={()=>setShowCreateForm(false)}/>
              <motion.div initial={{x:'100%'}} animate={{x:0}} exit={{x:'100%'}} transition={{type:'spring',stiffness:300,damping:30}} className="absolute right-0 top-0 bottom-0 w-2/3 bg-white shadow-lg p-8 overflow-y-auto z-20">
                <h2 className="text-2xl font-bold mb-4">Create Trade</h2>
                <p className="text-gray-600">(Form coming soon)</p>
                <button onClick={()=>setShowCreateForm(false)} className="mt-4 bg-gray-300 px-4 py-2 rounded-lg">Close</button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Debug options, only visible to developers */}
      <div className="mt-4 text-xs text-gray-500 border-t pt-4">
        <details>
          <summary className="cursor-pointer">Debug Options</summary>
          <div className="mt-2 space-y-2">
            <div>
              <label className="block mb-1">XAUUSD P/L Multiplier:</label>
              <input 
                type="number" 
                defaultValue={XAUUSD_MULTIPLIER} 
                onChange={(e) => {
                  window.XAUUSD_DEBUG_MULTIPLIER = parseFloat(e.target.value);
                  console.log(`Debug: Set XAUUSD multiplier to ${window.XAUUSD_DEBUG_MULTIPLIER}`);
                }}
                className="border p-1 w-24"
              />
              <button 
                onClick={() => {
                  // Recalculate P/L for all trades using the debug multiplier
                  if (window.XAUUSD_DEBUG_MULTIPLIER) {
                    const updatedTrades = tradeList.map(trade => {
                      if (trade.instrument.toUpperCase().includes('XAUUSD')) {
                        const priceDiff = trade.exitPrice - trade.entryPrice;
                        const mult = trade.tradeType === 'Long' ? 1 : -1;
                        const newPL = priceDiff * mult * window.XAUUSD_DEBUG_MULTIPLIER * trade.quantity;
                        console.log(`Recalculated P/L for trade ${trade.id}: ${trade.profitLoss} -> ${newPL}`);
                        return {...trade, profitLoss: newPL};
                      }
                      return trade;
                    });
                    setTradeList(updatedTrades);
                    if (selectedTrade) {
                      const updated = updatedTrades.find(t => t.id === selectedTrade.id);
                      if (updated) setSelectedTrade(updated);
                    }
                  }
                }}
                className="bg-gray-200 px-2 py-1 ml-2 rounded"
              >
                Apply
              </button>
            </div>
            <div>
              <label className="block mb-1">Raw Trade Data:</label>
              <textarea 
                readOnly
                value={JSON.stringify(selectedTrade, null, 2)}
                className="w-full h-40 font-mono text-xs border p-2"
              />
            </div>
          </div>
        </details>
      </div>

      {/* Add hidden file input for image uploads */}
      <input 
        type="file" 
        id="image-upload" 
        accept="image/*" 
        className="hidden" 
        onChange={handleImageUpload}
        ref={fileInputRef => {
          if (fileInputRef && uploadingFor !== null && uploadSlot !== undefined) {
            fileInputRef.click();
          }
        }}
      />
    </div>
  );
}
