# -*- coding: utf-8 -*-
"""Candidate companies to probe, by the market they hire into.

This is a seed list of NAMES, not endpoints. discover.py turns each name into
slug variants and asks every CORS-open ATS whether it hosts a board for it, so
being wrong here costs one failed request and nothing else.
"""

INDIA = """
Razorpay Zerodha CRED Groww Meesho Swiggy Zomato Flipkart PhonePe Paytm Ola
OlaElectric Udaan Delhivery Lenskart Nykaa BrowserStack Postman Freshworks
Zoho Chargebee Whatfix MoEngage Netcore Darwinbox Zetwerk InMobi Glance
Dream11 MPL Unacademy Byjus Vedantu PhysicsWallah Cure.fit Practo PharmEasy
Licious Country-Delight Rebel-Foods Blinkit Zepto Dunzo Porter Rapido
Slice Jupiter Fi Navi KreditBee Lendingkart Yubi Perfios Signzy Setu
Juspay Cashfree PineLabs BharatPe Khatabook OkCredit Instamojo
Innovaccer HealthifyMe Springworks Hasura Atlan SirionLabs Icertis
Postman Sprinklr Gupshup Exotel Kaleyra Haptik Yellow.ai Observe.ai
Uniphore Mindtickle LeadSquared Kissflow Vymo Locus Shiprocket
Turing Deel-India Skit Krutrim Sarvam Fractal Tredence LatentView
Mu-Sigma Quantiphi CleverTap WebEngage Amagi Ather Bounce Yulu
Cars24 Spinny Droom CarDekho Policybazaar Acko Digit Turtlemint
Bijnis Udaan OfBusiness Moglix Infra.Market Jumbotail ElasticRun
Apna Wellfound-India Naukri Instahyre Cutshort HirePro
Chargebee Clevertap Capillary Netradyne Ninjacart Toddle Teachmint
Classplus Scaler NxtWave Newton-School Masai GeeksforGeeks
"""

US_GLOBAL = """
Stripe Airbnb Coinbase Databricks Snowflake Datadog Figma Notion Linear
Vercel Netlify Cloudflare Fastly HashiCorp GitLab Docker Grafana Elastic
MongoDB Redis Confluent Cockroach Neon Supabase PlanetScale Render
OpenAI Anthropic Cohere Scale Together Perplexity Mistral HuggingFace
Replicate Modal Weights-Biases LangChain Pinecone Chroma Weaviate
Ramp Brex Plaid Mercury Modern-Treasury Checkr Gusto Rippling Deel
Remote Oyster Justworks Lattice Culture-Amp Greenhouse Ashby Lever
Asana Monday Airtable Coda Miro Loom Calendly Zapier Retool Webflow
Segment Amplitude Mixpanel Heap PostHog Sentry LaunchDarkly Split
Twilio SendGrid Auth0 Okta Duo JumpCloud 1Password Dashlane
Instacart DoorDash Lyft Robinhood Chime Affirm Klarna Wise Revolut
Reddit Discord Twitch Patreon Substack Medium Ghost Bluesky
Duolingo Coursera Udemy Khan-Academy Codecademy Pluralsight
Roblox Unity Epic-Games Riot-Games Zynga Playtika
Samsara Verkada Rivian Lucid Nuro Waymo Zoox Aurora
Anduril Palantir SpaceX Relativity Astranis Varda
Benchling Recursion Tempus Color Grail Ginkgo
Attentive Klaviyo Braze Iterable Customer-io
Vanta Drata Secureframe Snyk Wiz Orca Lacework
Airbyte Fivetran dbt-Labs Dagster Prefect Astronomer Sigma Hex
Retool Clay Attio Rippling Pilot Puzzle
"""

EUROPE = """
Spotify Klarna Northvolt Truecaller Kry Einride Voi Tink Trustly
Adyen Booking Mollie Bunq Backbase Picnic Miro-EU Framer
N26 Trade-Republic Solaris Raisin Wefox Personio Celonis
Zalando Delivery-Hero HelloFresh GetYourGuide Omio Babbel SoundCloud
Contentful Camunda Forto Sennder Flix Wandelbots
Doctolib BlaBlaCar Qonto Alan Swile Payfit Spendesk Ledger
Dataiku Mirakl Contentsquare Back-Market Sorare ManoMano
Revolut Monzo Starling Wise-UK Checkout Thought-Machine
Deliveroo Depop Bulb Octopus-Energy Darktrace Improbable Graphcore
Cazoo Zego Marshmallow Onfido ComplyAdvantage Tessian Snyk-UK
Typeform Glovo Cabify Factorial TravelPerk Jobandtalent Wallbox
Satispay Scalapay Bending-Spoons Musixmatch Casavo
Bolt Wolt Veriff Pipedrive Glia Skeleton Starship
Vinted Nord-Security Kilo-Health Whitebridge
Pleo Templafy Corti Zendesk Unity-DK Trustpilot
DeepL Ottobock Volocopter Lilium Isar-Aerospace
"""

ANZ_CANADA = """
Atlassian Canva Airwallex Afterpay Zip SafetyCulture Culture-Amp-AU
Linktree Employment-Hero Deputy Rokt Immutable Eucalyptus
Xero Vend Halter Rocket-Lab Sharesies Hnry
Shopify Wealthsimple Clio Hootsuite Faire Ada Cohere-CA
Wattpad Ecobee Miovision Vidyard Jobber Later Thinkific
Benevity Absorb Neo-Financial Koho Nuvei Lightspeed
"""

REMOTE_FIRST = """
Automattic Zapier-Remote Buffer Doist Toggl Hotjar Ghost-Remote
GitLab-Remote Close Chili-Piper Float ClickUp Time-Doctor
Aha Hopin Andela Turing-Remote Crossover X-Team Toptal
Elastic-Remote Sourcegraph Netlify-Remote Fly-io Railway
"""


def names():
    out = []
    for block in (INDIA, US_GLOBAL, EUROPE, ANZ_CANADA, REMOTE_FIRST):
        for token in block.split():
            if token not in out:
                out.append(token)
    return out


REGION_OF = {}
for block, region in ((INDIA, "India"), (US_GLOBAL, "US"), (EUROPE, "Europe"),
                      (ANZ_CANADA, "ANZ/Canada"), (REMOTE_FIRST, "Remote")):
    for token in block.split():
        REGION_OF.setdefault(token, region)

if __name__ == "__main__":
    n = names()
    print(len(n), "candidate names")
