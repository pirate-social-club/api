# CI references

`core.sha` is the exact Core commit used by API CI for contracts, schemas,
migrations, and cross-repository package dependencies. Update it only to a full
commit SHA that the API changes are intended to support.

Manual `api-ci` runs may supply a different full Core SHA to test a proposed pair
before changing this file. Push runs always use the committed pin, making the
API/Core compatibility pair durable and reproducible from the API commit alone.
