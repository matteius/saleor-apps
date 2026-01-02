#!/bin/bash
# Deploy latest images for all 3 Saleor apps

set -e

echo "=== Deploying Saleor Stripe App ==="
result=$(doctl registry repository list-tags saleor-stripe-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/saleor-stripe-app-prod saleor-stripe-app-prod=registry.digitalocean.com/whitewhale/saleor-stripe-app@{} -n whitewhale)
echo $result

echo "=== Deploying Saleor SMTP App ==="
result=$(doctl registry repository list-tags saleor-smtp-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/saleor-app-smtp saleor-app-smtp=registry.digitalocean.com/whitewhale/saleor-smtp-app@{} -n whitewhale)
echo $result

echo "=== Deploying OCR Credits App ==="
result=$(doctl registry repository list-tags saleor-ocr-credits-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/ocr-credits ocr-credits=registry.digitalocean.com/whitewhale/saleor-ocr-credits-app@{} -n whitewhale)
echo $result

echo "=== All deployments complete ==="
