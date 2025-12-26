result=$(doctl registry repository list-tags saleor-stripe-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/saleor-stripe-app saleor-stripe-app=registry.digitalocean.com/whitewhale/saleor-stripe-app@{} -n whitewhale)
echo $result
result=$(doctl registry repository list-tags saleor-smtp-app | grep latest | grep -o sha256:.* | xargs -i kubectl set image deployment/saleor-app-smtp-test saleor-app-smtp-test=registry.digitalocean.com/whitewhale/saleor-smtp-app@{} -n whitewhale)
echo $result
