Cardano Network Summary using Blockfrost API

Overview
This project is a simple Python application developed as part of the Cardano Foundation 2025 Holiday Season Challenge.
It demonstrates how to interact with the Cardano blockchain using the Blockfrost API to retrieve real on-chain data from the Cardano mainnet.
The application was developed and executed using Google Colab.

Technologies Used
Python 3
Google Colab
Blockfrost API
Requests library

API Configuration
The application authenticates to the Blockfrost API using a project ID provided in the HTTP headers.

Implemented Endpoints
Latest Epoch – /epochs/latest
Transaction Metadata Labels – /metadata/txs/labels
Network Metrics – /metrics

Application Output
The notebook prints a Cardano Network Summary including the current epoch and available network data.
If network metrics are not yet available for the project, the application handles this scenario gracefully without errors.

Notes on Network Metrics
For new Blockfrost projects, the metrics endpoint may return an empty list.
This behavior is expected and does not indicate an error in the application or API usage.

Conclusion
This project demonstrates correct usage of the Blockfrost API, secure authentication, JSON data handling, and basic blockchain data exploration.
It fulfills the requirements of the Cardano Foundation Holiday Season Challenge and serves as a minimal working example of Cardano blockchain integration using Python.

Author
Piero Arturo Cárdenas Angulo