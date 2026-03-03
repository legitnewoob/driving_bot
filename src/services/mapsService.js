// services/mapsService.js
const axios = require("axios");

async function getGoogleMapsLink(postalCode) {
  if (!postalCode) throw new Error("Postal code is required");

  const encoded = encodeURIComponent(postalCode.trim());
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encoded}`;

  return {
    link: mapUrl,
    message: `📍 Here's your location link based on postal code *${postalCode}*:\n${mapUrl}`,
  };
}


async function getCoordinatesFromPostalCode(postalCode) {
  if (!postalCode) throw new Error("Postal code is required");

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(postalCode)}&key=${apiKey}`;

  const { data } = await axios.get(url);

  console.log("Geocoding response:", data);
  if (data.status === "OK") {
    const location = data.results[0].geometry.location;
    const formattedAddress = data.results[0].formatted_address;
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;

    return {
      lat: location.lat,
      lng: location.lng,
      formattedAddress,
      mapUrl,
      message: `📍 *Location Found!*\n${formattedAddress}\n\nGoogle Maps: ${mapUrl}`,
    };
  }

  throw new Error(`Geocoding failed: ${data.status}`);
}


module.exports = { getGoogleMapsLink , getCoordinatesFromPostalCode };