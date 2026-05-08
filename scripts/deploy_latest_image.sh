result=$(doctl registry repository list-tags saleor-stripe-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/saleor-stripe-app-prod saleor-stripe-app-prod=registry.digitalocean.com/whitewhale/saleor-stripe-app@{} -n whitewhale)
echo $result
result=$(doctl registry repository list-tags saleor-smtp-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/saleor-app-smtp saleor-app-smtp=registry.digitalocean.com/whitewhale/saleor-smtp-app@{} -n whitewhale)
echo $result
